import { performance } from "node:perf_hooks";
import { workerData } from "node:worker_threads";

import { MilvusClient } from "@zilliz/milvus2-sdk-node";

import sql from "../../sql.ts";
import { config } from "../lib/segment-config.ts";
import {
  detectSeriesSegments,
  findDuplicateSegment,
  loadBrandingClaims,
  loadFrames,
  matchSegmentToFiles,
  sampleFrames,
  type ExistingSegment,
  type GroupFile,
  type SegmentMatch,
} from "../lib/segment-detect.ts";
import { extractSegment, pruneMatches } from "../lib/segment-extract.ts";

const { MILVUS_ADDR, MILVUS_TOKEN } = process.env;

const { anilistId, force } = workerData;
console.info(`[dedup][doing] anilist ${anilistId}`);

const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });

let detectMs = 0;
let extractMs = 0;
let segmentsFound = 0;
let groupCount = 0;
const log: any[] = [];

try {
  const group: GroupFile[] = await sql`
    SELECT
      id,
      duration
    FROM
      files
    WHERE
      anilist_id = ${anilistId}
      AND loaded = TRUE
      AND segment_type IS NULL
    ORDER BY
      episode_start ASC NULLS LAST,
      id ASC
  `;
  groupCount = group.length;
  console.info(`[dedup] anilist ${anilistId} ${group.length} loaded episodes`);

  const segments = await sql`
    SELECT
      id,
      segment_type,
      loaded
    FROM
      files
    WHERE
      anilist_id = ${anilistId}
      AND segment_type IS NOT NULL
  `;
  console.info(
    `[dedup] anilist ${anilistId} ${segments.length} existing segments ` +
      `(${segments.filter((e) => e.loaded).length} loaded)`,
  );

  const [previous] = await sql`
    SELECT
      loaded_file_count,
      log
    FROM
      dedup_runs
    WHERE
      anilist_id = ${anilistId}
  `;
  // a deferred run leaves this marker behind, because it records the current
  // episode count and would otherwise make `grew` false and lose the full
  // detection it owed until the series grew by the ratio all over again
  const owed = previousLog(previous).some((e) => e?.deferred);

  // full detection when there is nothing yet, when forced, or once the series
  // grew enough that the previous result is likely no longer the best one
  const grew = previous ? group.length >= previous.loaded_file_count * config.redetectRatio : true;
  const due = force || segments.length === 0 || grew || owed;
  // a segment that is still being indexed has not pruned its ranges out of
  // milvus yet, so detection would rediscover its own footage. the incremental
  // pass is safe meanwhile, and the series comes back here once it has loaded
  const indexing = segments.filter((e) => !e.loaded);
  const fullRun = due && indexing.length === 0;
  if (due && !fullRun) log.push({ deferred: true, indexing: indexing.length });
  console.info(
    `[dedup] anilist ${anilistId} fullRun=${fullRun} (force=${!!force} noSegments=${
      segments.length === 0
    } grew=${grew} owed=${owed} indexing=${indexing.length})`,
  );

  const startDetect = performance.now();

  if (fullRun) {
    const claimed = await loadBrandingClaims(group.map((e) => e.id));
    console.info(`[dedup] anilist ${anilistId} ${claimed.size} episodes carry a branding bumper`);

    console.info(`[dedup][doing] anilist ${anilistId} detecting candidates`);
    const candidates = await detectSeriesSegments(
      milvus,
      anilistId,
      group,
      ["opening", "ending"],
      claimed,
    );
    detectMs = (performance.now() - startDetect) | 0;
    console.info(
      `[dedup][done]  anilist ${anilistId} detected ${candidates.length} candidates in ${detectMs}ms`,
    );

    // the same opening must never be cut twice. a series can legitimately have
    // several openings, so what disqualifies a candidate is being the footage
    // of a segment that already exists - not how many of its episodes are new
    const existing: ExistingSegment[] = [];
    for (const segment of segments) {
      existing.push({
        id: segment.id,
        segment_type: segment.segment_type,
        loaded: segment.loaded,
        frames: await loadFrames(segment.id),
        matches: await sql`
          SELECT
            file_id,
            start_time,
            end_time
          FROM
            segment_matches
          WHERE
            segment_file_id = ${segment.id}
        `,
      });
    }
    console.info(
      `[dedup] anilist ${anilistId} comparing against ${existing.length} existing segments`,
    );

    const startExtract = performance.now();
    for (const candidate of candidates) {
      const referenceFrames = await loadFrames(candidate.reference_file_id);
      const probes = sampleFrames(
        referenceFrames,
        candidate.start,
        candidate.end,
        config.sampleInterval,
      );
      const duplicate = findDuplicateSegment(candidate, probes, existing);
      if (duplicate) {
        console.info(
          `[dedup] anilist ${anilistId} ${candidate.type} skipped: same footage as ` +
            `segment ${duplicate.id} (${duplicate.segment_type})`,
        );
        log.push({
          type: candidate.type,
          skipped: "duplicate",
          duplicateOf: duplicate.id,
          ...summary(candidate),
        });
        // the episodes it explains still have to be pruned, just against the
        // segment that already carries this footage
        await linkToExisting(duplicate, candidate.matches, group);
        continue;
      }
      if (config.milvusReadonly) {
        console.info(
          `[dedup] anilist ${anilistId} ${candidate.type} skipped: DEDUP_MILVUS_READONLY`,
        );
        log.push({ type: candidate.type, skipped: "DEDUP_MILVUS_READONLY", ...summary(candidate) });
        continue;
      }
      const { segmentFileId, relativePath } = await extractSegment(candidate);
      segmentsFound++;
      // a later candidate of this same run may be this footage again
      existing.push({
        id: segmentFileId,
        segment_type: candidate.type,
        loaded: false,
        frames: referenceFrames.filter((e) => e.time >= candidate.start && e.time <= candidate.end),
        matches: candidate.matches,
      });
      log.push({ type: candidate.type, segmentFileId, relativePath, ...summary(candidate) });
      console.info(
        `[dedup] anilist ${anilistId} ${candidate.type} ${candidate.duration.toFixed(1)}s ` +
          `x${candidate.support} -> ${relativePath}`,
      );
    }
    extractMs = (performance.now() - startExtract) | 0;
    console.info(
      `[dedup] anilist ${anilistId} extraction pass done: ${segmentsFound} segments in ${extractMs}ms`,
    );
  } else {
    // incremental: align the episodes that are not linked to a segment yet
    console.info(
      `[dedup][doing] anilist ${anilistId} incremental alignment of ${segments.length} segments`,
    );
    for (const segment of segments) {
      if (!segment.loaded) {
        console.info(
          `[dedup] segment ${segment.id} (${segment.segment_type}) skipped: not loaded yet`,
        );
        continue;
      }
      const linked = await sql`
        SELECT
          file_id
        FROM
          segment_matches
        WHERE
          segment_file_id = ${segment.id}
      `;
      const linkedIds = new Set(linked.map((e) => e.file_id));
      const targets = group.filter((e) => !linkedIds.has(e.id));
      if (targets.length === 0) {
        console.info(
          `[dedup] segment ${segment.id} (${segment.segment_type}) already linked to all episodes`,
        );
        continue;
      }

      console.info(
        `[dedup] segment ${segment.id} (${segment.segment_type}) checking ${targets.length} unlinked episodes`,
      );
      const matches = await matchSegmentToFiles(milvus, segment.id, targets);
      if (matches.length === 0) {
        console.info(
          `[dedup] segment ${segment.id} (${segment.segment_type}) no new matches found`,
        );
        continue;
      }
      await sql`
        INSERT INTO
          segment_matches ${sql(
            matches.map((e) => ({
              segment_file_id: segment.id,
              file_id: e.file_id,
              start_time: e.start_time,
              end_time: e.end_time,
              score: e.score,
            })),
          )}
        ON CONFLICT (segment_file_id, file_id) DO NOTHING
      `;
      segmentsFound++;
      console.info(
        `[dedup] segment ${segment.id} (${segment.segment_type}) added ${matches.length} segment_matches`,
      );
      log.push({ type: segment.segment_type, segmentFileId: segment.id, added: matches.length });
    }
    detectMs = (performance.now() - startDetect) | 0;
    console.info(`[dedup][done]  anilist ${anilistId} incremental alignment in ${detectMs}ms`);
  }

  // prune every segment of this series whose synthetic file is now queryable,
  // including ones extracted by an earlier run that had not loaded yet
  console.info(`[dedup] anilist ${anilistId} checking ${segments.length} segments for pruning`);
  for (const segment of segments) {
    const result = await pruneMatches(milvus, segment.id);
    if (result.pruned) log.push({ segmentFileId: segment.id, pruned: result.pruned });
  }

  console.info(
    `[dedup] anilist ${anilistId} computing dedup_runs row ` +
      `(loaded=${group.length} segmentsFound=${segmentsFound} detectMs=${detectMs} extractMs=${extractMs})`,
  );
  await sql`
    INSERT INTO
      dedup_runs ${sql({
        anilist_id: anilistId,
        loaded_file_count: group.length,
        segments_found: segmentsFound,
        detect_ms: detectMs,
        extract_ms: extractMs,
        log: JSON.stringify(log),
      })}
    ON CONFLICT (anilist_id) DO UPDATE
    SET
      updated = now(),
      loaded_file_count = excluded.loaded_file_count,
      segments_found = excluded.segments_found,
      detect_ms = excluded.detect_ms,
      extract_ms = excluded.extract_ms,
      log = excluded.log
  `;
} catch (error) {
  console.error(`[dedup][error] anilist ${anilistId}: ${error}`);
  // record the attempt so a failing series does not spin the stage forever -
  // it is retried once more episodes are indexed, or on demand via /debug
  await sql`
    INSERT INTO
      dedup_runs ${sql({
        anilist_id: anilistId,
        loaded_file_count: groupCount,
        segments_found: segmentsFound,
        detect_ms: detectMs,
        extract_ms: extractMs,
        log: JSON.stringify([...log, { error: String(error) }]),
      })}
    ON CONFLICT (anilist_id) DO UPDATE
    SET
      updated = now(),
      loaded_file_count = excluded.loaded_file_count,
      log = excluded.log
  `.catch((e) => console.error(e));
}

/**
 * Point the episodes a duplicate candidate explained at the segment that
 * already carries that footage, so they are still pruned. Only possible once
 * that segment is queryable; until then the incremental pass picks them up.
 */
async function linkToExisting(
  segment: ExistingSegment,
  matches: SegmentMatch[],
  group: GroupFile[],
) {
  const linked = new Set(segment.matches.map((e) => e.file_id));
  const targets = group.filter((e) => matches.some((m) => m.file_id === e.id) && !linked.has(e.id));
  if (targets.length === 0) return;
  if (!segment.loaded) {
    console.info(
      `[dedup] segment ${segment.id} not loaded yet, leaving ${targets.length} ` +
        `episodes for the next incremental run`,
    );
    return;
  }

  // realigned against the segment itself, which is more precise than the
  // candidate's own probe-spaced ranges and can never claim more than it covers
  const aligned = await matchSegmentToFiles(milvus, segment.id, targets);
  if (aligned.length === 0) return;
  await sql`
    INSERT INTO
      segment_matches ${sql(
        aligned.map((e) => ({
          segment_file_id: segment.id,
          file_id: e.file_id,
          start_time: e.start_time,
          end_time: e.end_time,
          score: e.score,
        })),
      )}
    ON CONFLICT (segment_file_id, file_id) DO NOTHING
  `;
  segment.matches.push(...aligned);
  console.info(
    `[dedup] segment ${segment.id} adopted ${aligned.length} episodes from a duplicate candidate`,
  );
}

/** The previous run's log, which is stored as a json-encoded string. */
function previousLog(previous: any): any[] {
  if (!previous?.log) return [];
  try {
    const parsed = typeof previous.log === "string" ? JSON.parse(previous.log) : previous.log;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summary(candidate: any) {
  return {
    start: Number(candidate.start.toFixed(3)),
    end: Number(candidate.end.toFixed(3)),
    duration: Number(candidate.duration.toFixed(3)),
    support: candidate.support,
    score: Number(candidate.score.toFixed(3)),
  };
}

await milvus.closeConnection();

await sql.end();

console.info(
  `[dedup][done]  anilist ${anilistId} detect=${detectMs}ms extract=${extractMs}ms segments=${segmentsFound}`,
);
