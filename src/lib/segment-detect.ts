import { promisify } from "node:util";
import zlib from "node:zlib";

import sql from "../../sql.ts";
import { config, SEGMENT_TYPES, type SegmentTypeConfig } from "./segment-config.ts";

const zstdDecompress = promisify(zlib.zstdDecompress);

export interface Frame {
  time: number;
  vector: number[];
}

export interface SegmentMatch {
  file_id: number;
  start_time: number;
  end_time: number;
  score: number;
  // where the segment's t=0 lands in the target, when it is known. start_time
  // is only as precise as the probe spacing; this is not.
  delta?: number;
}

export interface Candidate {
  type: string;
  anilist_id: number;
  reference_file_id: number;
  start: number;
  end: number;
  duration: number;
  support: number;
  score: number;
  matches: SegmentMatch[];
}

export interface GroupFile {
  id: number;
  duration: number;
}

const throwOnMilvusError = (result: any, what: string) => {
  if (result?.status?.error_code && result.status.error_code !== "Success") {
    throw new Error(
      result.status.reason ||
        result.status.detail ||
        `Milvus ${what} error: ${result.status.error_code}`,
    );
  }
};

/** Decompress files.color_layout into the per-frame vector list, sorted by time. */
export const loadFrames = async (fileId: number): Promise<Frame[]> => {
  const [row] = await sql`
    SELECT
      color_layout
    FROM
      files
    WHERE
      id = ${fileId}
  `;
  if (!row?.color_layout) return [];
  return JSON.parse((await zstdDecompress(row.color_layout)).toString()).sort(
    (a: Frame, b: Frame) => a.time - b.time,
  );
};

/** Pick roughly one frame every `interval` seconds inside [from, to]. */
export const sampleFrames = (frames: Frame[], from: number, to: number, interval: number) => {
  const probes: Frame[] = [];
  let nextTime = from;
  for (const frame of frames) {
    if (frame.time < from) continue;
    if (frame.time > to) break;
    if (frame.time + Number.EPSILON < nextTime) continue;
    probes.push(frame);
    nextTime = frame.time + interval;
  }
  return probes;
};

/**
 * Search every probe against the collection and return, per probe, the hits
 * that are close enough to count as the same frame.
 */
export const searchProbes = async (
  milvus: any,
  probes: Frame[],
  fileIds: number[] | null,
  excludeFileIds: number[] | null = null,
): Promise<{ file_id: number; time: number; score: number }[][]> => {
  // a global probe is capped at searchLimit hits, so callers that need to walk
  // past that cap re-query while excluding what they already have
  const clauses: string[] = [];
  const exprValues: Record<string, number[]> = {};
  if (fileIds) {
    clauses.push("file_id IN {list}");
    exprValues.list = fileIds;
  }
  if (excludeFileIds?.length) {
    clauses.push("file_id NOT IN {exclude}");
    exprValues.exclude = excludeFileIds;
  }
  const expr = clauses.length > 0 ? clauses.join(" and ") : null;

  const perProbe: { file_id: number; time: number; score: number }[][] = [];
  for (let i = 0; i < probes.length; i += config.probeChunkSize) {
    const chunk = probes.slice(i, i + config.probeChunkSize);
    const result = await milvus.search({
      collection_name: "frame_color_layout",
      data: chunk.map((e) => e.vector),
      limit: config.searchLimit,
      expr,
      exprValues: expr ? exprValues : null,
      output_fields: ["file_id", "time"],
    });
    throwOnMilvusError(result, "search");
    // batched searches come back as one result array per probe
    const results = Array.isArray(result.results[0]) ? result.results : [result.results];
    for (const hits of results) {
      perProbe.push(hits.filter((e: any) => e.score <= config.maxL2));
    }
  }
  return perProbe;
};

/** Time ranges per file that an already-accepted segment covers. */
export type ClaimedRanges = Map<number, [number, number][]>;

const isClaimed = (claimed: ClaimedRanges, fileId: number, time: number) =>
  (claimed.get(fileId) ?? []).some(([start, end]) => time >= start && time <= end);

const addClaimed = (claimed: ClaimedRanges, candidate: Candidate) => {
  for (const match of candidate.matches) {
    const ranges = claimed.get(match.file_id);
    if (ranges) ranges.push([match.start_time, match.end_time]);
    else claimed.set(match.file_id, [[match.start_time, match.end_time]]);
  }
};

/**
 * The ranges the branding stage already claimed in these files. Branding runs
 * before opening/ending detection precisely so those ranges can be masked out
 * here - a bumper at t=0 would otherwise be swallowed by the opening.
 */
export const loadBrandingClaims = async (fileIds: number[]): Promise<ClaimedRanges> => {
  const claimed: ClaimedRanges = new Map();
  if (fileIds.length === 0) return claimed;
  for (const row of await sql`
    SELECT
      m.file_id,
      m.start_time,
      m.end_time
    FROM
      segment_matches m
      JOIN files s ON s.id = m.segment_file_id
    WHERE
      s.segment_type = 'branding'
      AND m.file_id IN ${sql(fileIds)}
  `) {
    const ranges = claimed.get(row.file_id);
    if (ranges) ranges.push([row.start_time, row.end_time]);
    else claimed.set(row.file_id, [[row.start_time, row.end_time]]);
  }
  return claimed;
};

/** Merge sorted timestamps into runs, tolerating gaps up to `gapTolerance`. */
export const mergeRuns = (times: number[], gapTolerance: number) => {
  const runs: { start: number; end: number; count: number }[] = [];
  for (const time of times) {
    const last = runs[runs.length - 1];
    if (last && time - last.end <= gapTolerance) {
      last.end = time;
      last.count++;
    } else {
      runs.push({ start: time, end: time, count: 1 });
    }
  }
  return runs;
};

/**
 * Core detection: probe a reference episode against its own series and look for
 * a diagonal in the (referenceTime, targetTime) match matrix — a repeated
 * segment shows up as a run of probes whose matches in a given episode all
 * share the same time offset.
 */
const detectForReference = (
  typeConfig: SegmentTypeConfig,
  anilistId: number,
  reference: GroupFile,
  probes: Frame[],
  perProbe: { file_id: number; time: number; score: number }[][],
  group: GroupFile[],
  claimed: ClaimedRanges,
): Candidate | null => {
  const durationById = new Map(group.map((e) => [e.id, e.duration]));

  // per target file: delta bin -> matching (probeIndex, targetTime, score)
  const histograms = new Map<
    number,
    Map<number, { probe: number; time: number; score: number }[]>
  >();
  for (let i = 0; i < perProbe.length; i++) {
    const referenceTime = probes[i].time;
    // footage already claimed by an accepted segment must not be found twice -
    // e.g. a first episode that plays its opening at the end would otherwise
    // let the ending pass rediscover the opening
    if (isClaimed(claimed, reference.id, referenceTime)) continue;
    for (const hit of perProbe[i]) {
      if (hit.file_id === reference.id) continue;
      if (!durationById.has(hit.file_id)) continue;
      if (isClaimed(claimed, hit.file_id, hit.time)) continue;
      const bin = Math.round((hit.time - referenceTime) / config.deltaBin);
      let byBin = histograms.get(hit.file_id);
      if (!byBin) {
        byBin = new Map();
        histograms.set(hit.file_id, byBin);
      }
      const entries = byBin.get(bin);
      if (entries) entries.push({ probe: i, time: hit.time, score: hit.score });
      else byBin.set(bin, [{ probe: i, time: hit.time, score: hit.score }]);
    }
  }

  // for each target, keep only its dominant offset (plus immediate neighbours,
  // which absorb sub-bin drift) and record which probes it supports
  const supportedProbes = new Map<number, Map<number, { time: number; score: number }>>();
  const deltaByFile = new Map<number, number>();
  for (const [fileId, byBin] of histograms) {
    let bestBin = null;
    let bestCount = 0;
    for (const [bin, entries] of byBin) {
      if (entries.length > bestCount) {
        bestCount = entries.length;
        bestBin = bin;
      }
    }
    if (bestBin === null) continue;
    const kept = new Map<number, { time: number; score: number }>();
    for (let bin = bestBin - 2; bin <= bestBin + 2; bin++) {
      for (const entry of byBin.get(bin) ?? []) {
        const existing = kept.get(entry.probe);
        if (!existing || entry.score < existing.score) {
          kept.set(entry.probe, { time: entry.time, score: entry.score });
        }
      }
    }
    supportedProbes.set(fileId, kept);
    deltaByFile.set(fileId, bestBin * config.deltaBin);
  }

  // consensus timeline over the reference: probes backed by enough episodes
  const consensusTimes: number[] = [];
  for (let i = 0; i < probes.length; i++) {
    let support = 0;
    for (const kept of supportedProbes.values()) if (kept.has(i)) support++;
    if (support >= config.minSupport) consensusTimes.push(probes[i].time);
  }
  if (consensusTimes.length === 0) return null;

  const runs = mergeRuns(consensusTimes, config.gapTolerance);

  let best: Candidate | null = null;
  for (const run of runs) {
    let { start, end } = run;
    if (end - start < typeConfig.minDuration) continue;
    if (end - start > typeConfig.maxDuration) {
      // keep the part of the run closest to where this segment type lives
      if (typeConfig.tailWindow !== null) start = end - typeConfig.maxDuration;
      else end = start + typeConfig.maxDuration;
    }
    const duration = end - start;
    if (typeConfig.headWindow !== null && start > typeConfig.headWindow) continue;
    if (
      typeConfig.tailWindow !== null &&
      reference.duration &&
      end < reference.duration - typeConfig.tailWindow
    ) {
      continue;
    }

    const matches: SegmentMatch[] = [];
    let scoreSum = 0;
    let scoreCount = 0;
    for (const [fileId, kept] of supportedProbes) {
      const inRun = [...kept.entries()].filter(
        ([probeIndex]) => probes[probeIndex].time >= start && probes[probeIndex].time <= end,
      );
      // an episode only counts if it covers most of the consensus range
      if (inRun.length < Math.ceil((duration / config.sampleInterval) * 0.5)) continue;
      const targetDuration = durationById.get(fileId);
      const delta = deltaByFile.get(fileId);
      const score = inRun.reduce((sum, [, e]) => sum + e.score, 0) / inRun.length;
      scoreSum += score;
      scoreCount++;
      matches.push({
        file_id: fileId,
        start_time: Math.max(0, start + delta),
        end_time: targetDuration ? Math.min(targetDuration, end + delta) : end + delta,
        score,
      });
    }
    if (matches.length < config.minSupport) continue;

    // the reference carries the same content, so it is pruned like any other episode
    matches.push({ file_id: reference.id, start_time: start, end_time: end, score: 0 });

    const candidate: Candidate = {
      type: typeConfig.type,
      anilist_id: anilistId,
      reference_file_id: reference.id,
      start,
      end,
      duration,
      support: matches.length,
      score: scoreCount ? scoreSum / scoreCount : 0,
      matches,
    };
    if (!best || rankCandidate(candidate, typeConfig) > rankCandidate(best, typeConfig)) {
      best = candidate;
    }
  }
  return best;
};

/** More supporting episodes wins; ties go to the duration closest to the known-common length. */
const rankCandidate = (candidate: Candidate, typeConfig: SegmentTypeConfig) => {
  const preferenceBonus = typeConfig.preferredDuration
    ? -Math.abs(candidate.duration - typeConfig.preferredDuration)
    : 0;
  return candidate.support * 1000 + preferenceBonus + candidate.duration / 1000;
};

/**
 * Match an already-extracted segment against a set of episodes. This is the
 * cheap incremental path: once a series' opening is known, newly indexed
 * episodes only have to be aligned against it rather than re-detected.
 */
export const matchSegmentToFiles = async (
  milvus: any,
  segmentFileId: number,
  targets: GroupFile[],
): Promise<SegmentMatch[]> => {
  if (targets.length === 0) return [];
  const frames = await loadFrames(segmentFileId);
  if (frames.length === 0) return [];

  const probes = sampleFrames(frames, 0, frames[frames.length - 1].time, config.sampleInterval);
  if (probes.length === 0) return [];

  const durationById = new Map(targets.map((e) => [e.id, e.duration]));
  const perProbe = await searchProbes(
    milvus,
    probes,
    targets.map((e) => e.id),
  );

  const histograms = new Map<number, Map<number, { probe: number; score: number }[]>>();
  for (let i = 0; i < perProbe.length; i++) {
    for (const hit of perProbe[i]) {
      if (!durationById.has(hit.file_id)) continue;
      const bin = Math.round((hit.time - probes[i].time) / config.deltaBin);
      let byBin = histograms.get(hit.file_id);
      if (!byBin) {
        byBin = new Map();
        histograms.set(hit.file_id, byBin);
      }
      const entries = byBin.get(bin);
      if (entries) entries.push({ probe: i, score: hit.score });
      else byBin.set(bin, [{ probe: i, score: hit.score }]);
    }
  }

  const matches: SegmentMatch[] = [];
  for (const [fileId, byBin] of histograms) {
    let bestBin = null;
    let bestCount = 0;
    for (const [bin, entries] of byBin) {
      if (entries.length > bestCount) {
        bestCount = entries.length;
        bestBin = bin;
      }
    }
    if (bestBin === null) continue;

    const kept = new Map<number, number>();
    for (let bin = bestBin - 2; bin <= bestBin + 2; bin++) {
      for (const entry of byBin.get(bin) ?? []) {
        const existing = kept.get(entry.probe);
        if (existing === undefined || entry.score < existing) kept.set(entry.probe, entry.score);
      }
    }
    // the episode has to carry most of the segment, not just a stray frame
    if (kept.size < probes.length * 0.5) continue;

    const probeTimes = [...kept.keys()].map((i) => probes[i].time);
    const delta = bestBin * config.deltaBin;
    const targetDuration = durationById.get(fileId);
    const start = Math.min(...probeTimes) + delta;
    const end = Math.max(...probeTimes) + delta;
    matches.push({
      file_id: fileId,
      start_time: Math.max(0, start),
      end_time: targetDuration ? Math.min(targetDuration, end) : end,
      score: [...kept.values()].reduce((sum, e) => sum + e, 0) / kept.size,
      delta,
    });
  }
  return matches;
};

/**
 * Detect the openings/endings shared by the episodes of one anilist_id.
 * `claimed` seeds the mask with footage another pass already explained - the
 * branding stage runs first, and its bumpers must not end up inside an opening.
 */
export const detectSeriesSegments = async (
  milvus: any,
  anilistId: number,
  group: GroupFile[],
  types: string[] = ["opening", "ending"],
  claimed: ClaimedRanges = new Map(),
): Promise<Candidate[]> => {
  const accepted: Candidate[] = [];

  for (const typeName of types) {
    const typeConfig = SEGMENT_TYPES[typeName];
    // a series often changes its opening/ending at a cour boundary, so keep
    // peeling off the episodes each accepted segment explains and look again
    let remaining = group;
    let referenceOffset = 0;
    let found = 0;

    for (let round = 0; round < config.maxDetectRounds; round++) {
      if (remaining.length <= config.minSupport) break;
      if (found >= config.maxSegmentsPerType) break;
      const references = remaining.slice(referenceOffset, referenceOffset + config.references);
      if (references.length === 0) break;
      const fileIds = remaining.map((e) => e.id);
      let best: Candidate | null = null;

      for (const reference of references) {
        const frames = await loadFrames(reference.id);
        if (frames.length === 0) continue;

        const from =
          typeConfig.headWindow !== null
            ? 0
            : Math.max(0, reference.duration - typeConfig.tailWindow);
        const to =
          typeConfig.headWindow !== null ? typeConfig.headWindow : (reference.duration ?? Infinity);

        const probes = sampleFrames(frames, from, to, config.sampleInterval);
        if (probes.length === 0) continue;

        const perProbe = await searchProbes(milvus, probes, fileIds);
        const candidate = detectForReference(
          typeConfig,
          anilistId,
          reference,
          probes,
          perProbe,
          remaining,
          claimed,
        );
        if (
          candidate &&
          (!best || rankCandidate(candidate, typeConfig) > rankCandidate(best, typeConfig))
        ) {
          best = candidate;
        }
      }

      if (!best) {
        // these references explain nothing - the first episodes of a series are
        // often atypical - so try later ones rather than giving up on the rest.
        // they stay in the pool, they just stop being used as the reference.
        referenceOffset += config.references;
        continue;
      }
      accepted.push(best);
      found++;
      referenceOffset = 0;
      // no later pass may claim this footage again
      addClaimed(claimed, best);

      const explained = new Set(best.matches.map((e) => e.file_id));
      remaining = remaining.filter((e) => !explained.has(e.id));
    }
  }

  return accepted;
};
