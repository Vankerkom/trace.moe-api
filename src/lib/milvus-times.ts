// Read-side helpers for "what does Milvus actually hold for this file", shared
// by the /debug/milvus/* endpoints so they cannot disagree with each other.
import { config } from "./segment-config.ts";
import { DEDUPE_WINDOW } from "./dedupe-hash-list.ts";
import { mergeRuns } from "./segment-detect.ts";

export interface Block {
  start: number;
  end: number;
  count: number;
}

export interface Coverage {
  count: number;
  blocks: Block[];
  minTime: number | null;
  maxTime: number | null;
  largestGap: number;
  coveredSeconds: number;
  blocksTruncated: boolean;
}

/**
 * Loading can only ever leave a hole of about DEDUPE_WINDOW, since a frame is
 * dropped only when an identical one sits within that window. The shortest hole
 * a prune can leave is the shortest segment minus both margins, which is well
 * clear of it, so this threshold separates "normal" from "pruned".
 */
export const defaultGapThreshold = DEDUPE_WINDOW * 1.25;

// beyond this a file is pathological; coalesce the tail rather than ship it all
const MAX_BLOCKS = 500;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Every indexed timestamp for one file, ascending. Paginated: an episode holds
 * more rows than Milvus will return in a single query, and both `limit` and
 * `offset + limit` are capped at 16384, so a plain query silently truncates.
 * Strong consistency because a debug view has to show a prune that just landed.
 */
export const fetchFileTimes = async (milvus: any, fileId: number): Promise<number[]> => {
  const iterator = await milvus.queryIterator({
    collection_name: "frame_color_layout",
    filter: `file_id == ${fileId}`,
    output_fields: ["time"],
    batchSize: 16384,
    consistency_level: "Strong",
  });

  const times: number[] = [];
  for await (const batch of iterator) {
    for (const entry of batch) times.push(entry.time);
  }
  // the iterator pages by primary key, so batches arrive unordered in time
  return times.sort((a, b) => a - b);
};

/** Collapse ascending timestamps into the contiguous ranges they cover. */
export const collapseBlocks = (times: number[], gapThreshold: number): Coverage => {
  const runs = mergeRuns(times, gapThreshold);
  const blocksTruncated = runs.length > MAX_BLOCKS;
  if (blocksTruncated) {
    // fold everything past the cap into one block so the totals stay honest
    const tail = runs.splice(MAX_BLOCKS - 1);
    runs.push({
      start: tail[0].start,
      end: tail[tail.length - 1].end,
      count: tail.reduce((sum, run) => sum + run.count, 0),
    });
  }

  let largestGap = 0;
  for (let i = 1; i < runs.length; i++) {
    largestGap = Math.max(largestGap, runs[i].start - runs[i - 1].end);
  }

  return {
    count: times.length,
    blocks: runs.map((run) => ({
      start: round(run.start),
      end: round(run.end),
      count: run.count,
    })),
    minTime: times.length ? round(times[0]) : null,
    maxTime: times.length ? round(times[times.length - 1]) : null,
    largestGap: round(largestGap),
    coveredSeconds: round(runs.reduce((sum, run) => sum + (run.end - run.start), 0)),
    blocksTruncated,
  };
};

/**
 * Frames per time bucket. The near-duplicate filter thins a static scene down
 * to roughly one frame every DEDUPE_WINDOW seconds instead of cutting it out,
 * so its effect never shows up as a gap between blocks — only as a drop in
 * density against the frames that were available.
 */
export const bucketDensity = (times: number[], axis: number, buckets: number): number[] => {
  const density = new Array(buckets).fill(0);
  if (!axis) return density;
  for (const time of times) {
    const bucket = Math.min(buckets - 1, Math.floor((time / axis) * buckets));
    if (bucket >= 0) density[bucket]++;
  }
  return density;
};

/**
 * Which parts of `expected` are not in `indexed`. Milvus stores `time` as a
 * 32-bit float while color_layout keeps ffmpeg's float64 pts, so this compares
 * intervals rather than timestamps, and drops residuals below `tolerance`.
 */
export const subtractBlocks = (
  expected: Block[],
  indexed: Block[],
  tolerance = config.pruneMargin / 2,
): { start: number; end: number }[] => {
  const missing: { start: number; end: number }[] = [];

  for (const block of expected) {
    // walk the block left to right, cutting away each overlapping indexed range
    let cursor = block.start;
    for (const hit of indexed) {
      if (hit.end < cursor) continue;
      if (hit.start > block.end) break;
      if (hit.start - cursor > tolerance) {
        missing.push({ start: round(cursor), end: round(hit.start) });
      }
      cursor = Math.max(cursor, hit.end);
      if (cursor >= block.end) break;
    }
    if (block.end - cursor > tolerance) {
      missing.push({ start: round(cursor), end: round(block.end) });
    }
  }

  return missing;
};
