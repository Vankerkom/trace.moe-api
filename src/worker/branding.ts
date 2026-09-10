import { performance } from "node:perf_hooks";

import { MilvusClient } from "@zilliz/milvus2-sdk-node";

import sql from "../../sql.ts";
import { discoverCandidates, loadBrandingPool, type BrandingItem } from "../lib/branding-pool.ts";
import { config, SEGMENT_TYPES } from "../lib/segment-config.ts";
import { matchSegmentToFiles, type GroupFile } from "../lib/segment-detect.ts";
import { pruneMatches } from "../lib/segment-extract.ts";

const { MILVUS_ADDR, MILVUS_TOKEN } = process.env;

console.info(`[branding][doing] ${config.brandingPath}`);

const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });

const typeConfig = SEGMENT_TYPES.branding;

/**
 * Register the clip as an ordinary files row pointing at the file on disk.
 * Nothing is cut or copied - the media-info / scene-changes / color-layout /
 * milvus-load stages index it exactly like an episode. anilist_id stays NULL
 * because a studio logo does not belong to any one series.
 */
const registerClip = async (item: BrandingItem) => {
  const [existing] = await sql`
    SELECT
      id,
      path,
      duration,
      color_layout IS NOT NULL AS hashed
    FROM
      files
    WHERE
      segment_type = 'branding'
      AND segment_label = ${item.label}
  `;
  if (existing) return existing;

  const [inserted] = await sql`
    INSERT INTO
      files ${sql({
        anilist_id: null,
        path: item.videoPath,
        segment_type: "branding",
        segment_label: item.label,
      })}
    ON CONFLICT (path) DO NOTHING
    RETURNING
      id,
      path,
      duration,
      color_layout IS NOT NULL AS hashed
  `;
  if (inserted) {
    console.info(`[branding] registered ${item.videoPath} as file ${inserted.id}`);
    return inserted;
  }

  // the path is already known under a different label - adopt that row rather
  // than leaving the clip unregistered forever
  const [byPath] = await sql`
    UPDATE files
    SET
      segment_type = 'branding',
      segment_label = ${item.label},
      updated = now()
    WHERE
      path = ${item.videoPath}
    RETURNING
      id,
      path,
      duration,
      color_layout IS NOT NULL AS hashed
  `;
  return byPath ?? null;
};

try {
  const items = await loadBrandingPool();
  if (items.length === 0) console.info(`[branding] no image/video pairs in ${config.brandingPath}`);

  // an already-extracted segment must never become the source of another one
  const segmentIds = new Set<number>(
    (
      await sql`
        SELECT
          id
        FROM
          files
        WHERE
          segment_type IS NOT NULL
      `
    ).map((e) => e.id),
  );

  for (const item of items) {
    const clip = await registerClip(item);
    if (!clip) {
      console.warn(`[branding] ${item.videoFile}: could not register, skipped`);
      continue;
    }
    segmentIds.add(clip.id);

    if (!clip.hashed) {
      // still working its way through the indexing stages
      console.info(`[branding] ${item.videoFile} (file ${clip.id}) not hashed yet, skipped`);
      continue;
    }

    // episodes already linked to this clip need no work
    const linkedIds = new Set(
      (
        await sql`
          SELECT
            file_id
          FROM
            segment_matches
          WHERE
            segment_file_id = ${clip.id}
        `
      ).map((e) => e.file_id),
    );

    const startTime = performance.now();
    const candidateIds = (
      await discoverCandidates(milvus, item, new Set([...segmentIds, ...linkedIds]))
    ).filter((id) => !linkedIds.has(id) && !segmentIds.has(id));

    if (candidateIds.length === 0) {
      console.info(
        `[branding] ${item.imageFile} no new candidates ` +
          `(${linkedIds.size} already linked, ${(performance.now() - startTime) | 0}ms)`,
      );
      await pruneMatches(milvus, clip.id);
      continue;
    }

    const targets: GroupFile[] = await sql`
      SELECT
        id,
        duration
      FROM
        files
      WHERE
        id IN ${sql(candidateIds)}
        AND loaded = TRUE
    `;

    // the still only says "this file contains the bumper somewhere"; the clip's
    // own frames are what fix the exact range in each episode
    const durationById = new Map(targets.map((e) => [e.id, e.duration]));
    const matches = (await matchSegmentToFiles(milvus, clip.id, targets))
      // the aligned range only spans the probes that matched, so it is short by
      // up to a sample interval at each end. The clip is the segment, so its own
      // duration is the truth - anchor the range on the alignment offset instead
      .map((match) => {
        if (match.delta === undefined || !clip.duration) return match;
        const targetDuration = durationById.get(match.file_id);
        const end = match.delta + clip.duration;
        return {
          ...match,
          start_time: Math.max(0, match.delta),
          end_time: targetDuration ? Math.min(targetDuration, end) : end,
        };
      })
      .filter((match) => {
        const duration = match.end_time - match.start_time;
        return (
          match.start_time <= typeConfig.headWindow &&
          duration >= typeConfig.minDuration &&
          duration <= typeConfig.maxDuration
        );
      });
    const detectMs = (performance.now() - startTime) | 0;

    if (matches.length < config.minSupport) {
      console.info(
        `[branding] ${item.imageFile} aligned to ${matches.length} of ${targets.length} ` +
          `candidates, below minimum (${detectMs}ms)`,
      );
      await pruneMatches(milvus, clip.id);
      continue;
    }

    if (config.milvusReadonly) {
      console.info(
        `[branding] ${item.imageFile} aligned to ${matches.length} files in ${detectMs}ms, ` +
          `not linking (DEDUP_MILVUS_READONLY)`,
      );
      continue;
    }

    await sql`
      INSERT INTO
        segment_matches ${sql(
          matches.map((e) => ({
            segment_file_id: clip.id,
            file_id: e.file_id,
            start_time: e.start_time,
            end_time: e.end_time,
            score: e.score,
          })),
        )}
      ON CONFLICT (segment_file_id, file_id) DO NOTHING
    `;
    console.info(
      `[branding] ${item.imageFile} +${matches.length} files ` +
        `(${linkedIds.size + matches.length} total, ${detectMs}ms)`,
    );

    await pruneMatches(milvus, clip.id);
  }
} catch (error) {
  console.error(`[branding][error] ${error}`);
}

await milvus.closeConnection();

await sql.end();

console.info(`[branding][done]  ${config.brandingPath}`);
