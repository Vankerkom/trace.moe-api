import path from "node:path";

const VIDEO_PATH = path.normalize(process.env.VIDEO_PATH);

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// treat only an explicit "0" / "false" as off, so an unset flag keeps the default
const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === "" ? fallback : !["0", "false", "no", "off"].includes(value);

export interface SegmentTypeConfig {
  type: string;
  minDuration: number;
  maxDuration: number;
  preferredDuration: number | null;
  // window (in seconds) at the head of the file the segment must start in, or null
  headWindow: number | null;
  // window (in seconds) at the tail of the file the segment must end in, or null
  tailWindow: number | null;
}

export const SEGMENT_TYPES: Record<string, SegmentTypeConfig> = {
  opening: {
    type: "opening",
    minDuration: num(process.env.DEDUP_OPENING_MIN, 45),
    maxDuration: num(process.env.DEDUP_OPENING_MAX, 180),
    preferredDuration: num(process.env.DEDUP_OPENING_PREFERRED, 90),
    headWindow: num(process.env.DEDUP_OPENING_SEARCH_WINDOW, 420),
    tailWindow: null,
  },
  ending: {
    type: "ending",
    minDuration: num(process.env.DEDUP_ENDING_MIN, 45),
    maxDuration: num(process.env.DEDUP_ENDING_MAX, 300),
    preferredDuration: num(process.env.DEDUP_ENDING_PREFERRED, 90),
    headWindow: null,
    tailWindow: num(process.env.DEDUP_ENDING_SEARCH_WINDOW, 420),
  },
  branding: {
    type: "branding",
    minDuration: num(process.env.DEDUP_BRANDING_MIN, 4.5),
    maxDuration: num(process.env.DEDUP_BRANDING_MAX, 30),
    preferredDuration: null,
    headWindow: num(process.env.DEDUP_BRANDING_SEARCH_WINDOW, 15),
    tailWindow: null,
  },
};

export const config = {
  enabled: bool(process.env.DEDUP_ENABLED, true),
  milvusReadonly: bool(process.env.DEDUP_MILVUS_READONLY, false),

  brandingPath: process.env.BRANDING_PATH || path.join(VIDEO_PATH, "branding"),
  segmentDir: "segments",

  // how many episodes of a series are used as detection references
  references: num(process.env.DEDUP_REFERENCES, 3),
  // probe every N seconds inside the candidate window
  sampleInterval: num(process.env.DEDUP_SAMPLE_INTERVAL, 1),
  // L2 distance below which two frames are considered the same frame
  maxL2: num(process.env.DEDUP_MAX_L2, 20),
  // resolution of the (targetTime - referenceTime) histogram
  deltaBin: num(process.env.DEDUP_DELTA_BIN, 0.25),
  // unmatched seconds tolerated inside a run (dark frames, small per-episode edits)
  gapTolerance: num(process.env.DEDUP_GAP_TOLERANCE, 4),
  // distinct episodes that must agree before a run is accepted
  minSupport: num(process.env.DEDUP_MIN_SUPPORT, 3),
  // shrink each pruned range by this much at both ends, so a slightly
  // misplaced boundary cannot delete frames of real episode content
  pruneMargin: num(process.env.DEDUP_PRUNE_MARGIN, 0.5),
  // full re-detection only once the episode count grew by this factor
  redetectRatio: num(process.env.DEDUP_REDETECT_RATIO, 1.5),
  // fraction of a candidate's frames that has to line up with an existing
  // segment, on one shared time offset, before the two are the same footage
  duplicateFrameRatio: num(process.env.DEDUP_DUPLICATE_FRAME_RATIO, 0.5),
  // fraction of the shorter range two matches on the same episode have to
  // share before they are the same footage
  duplicateOverlapRatio: num(process.env.DEDUP_DUPLICATE_OVERLAP_RATIO, 0.5),
  // a series can change its opening/ending at a cour boundary, so allow more
  // than one segment of the same type to be found across different episodes
  maxSegmentsPerType: num(process.env.DEDUP_MAX_SEGMENTS_PER_TYPE, 4),
  // upper bound on detection rounds per type, including rounds that find
  // nothing and only advance past a run of atypical episodes
  maxDetectRounds: num(process.env.DEDUP_MAX_DETECT_ROUNDS, 12),

  // a single global probe is capped at searchLimit hits, so branding discovery
  // repeats the query while excluding what it already found
  brandingDiscoveryRounds: num(process.env.DEDUP_BRANDING_DISCOVERY_ROUNDS, 10),

  // milvus probes sent per search call
  probeChunkSize: num(process.env.DEDUP_PROBE_CHUNK, 50),
  searchLimit: num(process.env.DEDUP_SEARCH_LIMIT, 1000),
};

export const segmentPath = (
  anilistId: number,
  type: string,
  segmentFileId: number,
  referenceFileId: number,
) => `${config.segmentDir}/${anilistId}/${type}-${segmentFileId}-${referenceFileId}.mkv`;
