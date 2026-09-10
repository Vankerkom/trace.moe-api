// Temporary local debugging surface for the segment deduplication flow.
// Unauthenticated, so it is only mounted when DEBUG_ENDPOINTS is set.
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import sql from "../sql.ts";
import { cachedBumpers, loadBumperPool, matchBumper } from "./lib/bumper-pool.ts";
import { config, SEGMENT_TYPES } from "./lib/segment-config.ts";
import { detectSeriesSegments, type GroupFile } from "./lib/segment-detect.ts";
import { pruneMatches, revertSegment } from "./lib/segment-extract.ts";

const runWorker = (file: string, workerData: any) =>
  new Promise<number>((resolve) => {
    const worker = new Worker(file, { workerData });
    worker.on("error", (error) => console.error(error));
    worker.on("exit", (code) => resolve(code));
  });

const loadGroup = (anilistId: number): Promise<GroupFile[]> => sql`
  SELECT
    id,
    duration,
    path
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

/** GET /debug/dedup/:anilistId - detect without writing anything. */
export const dedupDryRun = async (req, res) => {
  try {
    const anilistId = Number(req.params.anilistId);
    const group = await loadGroup(anilistId);
    if (group.length <= config.minSupport) {
      return res.json({
        anilistId,
        files: group.length,
        error: `needs more than ${config.minSupport} loaded files`,
      });
    }

    // ?types=ending runs one pass in isolation, which is how you tell a missing
    // segment apart from one suppressed by an earlier pass
    const types = req.query.types ? String(req.query.types).split(",") : undefined;

    const startTime = performance.now();
    const candidates = await detectSeriesSegments(req.app.locals.milvus, anilistId, group, types);
    const detectMs = (performance.now() - startTime) | 0;

    const pathById = new Map(group.map((e: any) => [e.id, e.path]));
    res.json({
      anilistId,
      files: group.length,
      detectMs,
      config: { ...config, types: SEGMENT_TYPES },
      candidates: candidates.map((candidate) => ({
        type: candidate.type,
        reference: pathById.get(candidate.reference_file_id),
        reference_file_id: candidate.reference_file_id,
        start: Number(candidate.start.toFixed(3)),
        end: Number(candidate.end.toFixed(3)),
        duration: Number(candidate.duration.toFixed(3)),
        support: candidate.support,
        score: Number(candidate.score.toFixed(3)),
        matches: candidate.matches
          .slice()
          .sort((a, b) => a.file_id - b.file_id)
          .map((match) => ({
            file_id: match.file_id,
            path: pathById.get(match.file_id),
            start_time: Number(match.start_time.toFixed(3)),
            end_time: Number(match.end_time.toFixed(3)),
            offset: Number((match.start_time - candidate.start).toFixed(3)),
            score: Number(match.score.toFixed(3)),
          })),
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** POST /debug/dedup/:anilistId/apply - run the real dedup worker for one series. */
export const dedupApply = async (req, res) => {
  try {
    const anilistId = Number(req.params.anilistId);
    const code = await runWorker("./src/worker/dedup.ts", {
      anilistId,
      force: "force" in req.query,
    });
    // the extracted segments are new files and still need indexing
    req.app.locals.taskManager.runMediaInfoTask();
    req.app.locals.taskManager.runSceneChangesTask();
    req.app.locals.taskManager.runColorLayoutTask();
    req.app.locals.taskManager.runMilvusLoadTask();
    const [run] = await sql`
      SELECT
        *
      FROM
        dedup_runs
      WHERE
        anilist_id = ${anilistId}
    `;
    res.json({
      anilistId,
      exitCode: code,
      milvusReadonly: config.milvusReadonly,
      run: run ?? null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** GET /debug/segments[/:anilistId] - extracted segments and their prune state. */
export const listSegments = async (req, res) => {
  try {
    const anilistId = req.params.anilistId ? Number(req.params.anilistId) : null;
    const segments = await sql`
      SELECT
        f.id,
        f.anilist_id,
        f.path,
        f.segment_type,
        f.segment_label,
        f.segment_reference_id,
        f.duration,
        f.loaded,
        count(m.id)::int AS matches,
        count(m.id) FILTER (
          WHERE
            m.milvus_deleted
        )::int AS pruned
      FROM
        files f
        LEFT JOIN segment_matches m ON m.segment_file_id = f.id
      WHERE
        f.segment_type IS NOT NULL ${anilistId === null
          ? sql``
          : sql`AND f.anilist_id = ${anilistId}`}
      GROUP BY
        f.id
      ORDER BY
        f.id DESC
    `;
    res.json({ segments });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** GET /debug/segments/:anilistId/episodes - episode timeline base data. */
export const listEpisodes = async (req, res) => {
  try {
    const anilistId = Number(req.params.anilistId);
    const episodes = await sql`
      SELECT
        id,
        episode_start,
        episode_end,
        path,
        duration,
        loaded
      FROM
        files
      WHERE
        anilist_id = ${anilistId}
        AND segment_type IS NULL
      ORDER BY
        episode_start ASC NULLS LAST,
        id ASC
    `;
    res.json({ anilistId, episodes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** GET /debug/segments/:segmentFileId/matches - the episodes behind one segment. */
export const segmentMatches = async (req, res) => {
  try {
    const matches = await sql`
      SELECT
        m.file_id,
        f.path,
        f.episode_start,
        m.start_time,
        m.end_time,
        m.score,
        m.milvus_deleted
      FROM
        segment_matches m
        JOIN files f ON f.id = m.file_id
      WHERE
        m.segment_file_id = ${Number(req.params.segmentFileId)}
      ORDER BY
        f.episode_start ASC NULLS LAST,
        m.file_id ASC
    `;
    res.json({ segmentFileId: Number(req.params.segmentFileId), matches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** POST /debug/segments/:segmentFileId/prune - prune ranges for one loaded segment. */
export const segmentPrune = async (req, res) => {
  try {
    const segmentFileId = Number(req.params.segmentFileId);
    const result = await pruneMatches(req.app.locals.milvus, segmentFileId);
    res.json({ segmentFileId, milvusReadonly: config.milvusReadonly, ...result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/**
 * POST /debug/segments/:segmentFileId/revert - undo a segment. The originals are
 * rebuilt from files.color_layout by the ordinary milvus-load stage.
 */
export const segmentRevert = async (req, res) => {
  try {
    const segmentFileId = Number(req.params.segmentFileId);
    const result = await revertSegment(req.app.locals.milvus, segmentFileId);
    if (!result) return res.status(404).json({ error: "no such segment" });
    req.app.locals.taskManager.runMilvusLoadTask();
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** POST /debug/prune - prune every pending range across all segments. */
export const pruneAll = async (req, res) => {
  try {
    const result = await pruneMatches(req.app.locals.milvus);
    res.json({ milvusReadonly: config.milvusReadonly, ...result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** GET /debug/bumpers - the still pool, its cached hashes, and what each matches. */
export const listBumpers = async (req, res) => {
  try {
    const bumpers = await loadBumperPool();
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
    const withMatches = [];
    for (const bumper of bumpers) {
      const startTime = performance.now();
      const matches =
        "match" in req.query ? await matchBumper(req.app.locals.milvus, bumper, segmentIds) : null;
      withMatches.push({
        label: bumper.label,
        file: bumper.file,
        vector: bumper.vector,
        detectMs: matches ? (performance.now() - startTime) | 0 : null,
        matchCount: matches?.length ?? null,
        matches: matches?.slice(0, 50) ?? null,
      });
    }
    res.json({ path: config.bumperPath, cached: cachedBumpers().length, bumpers: withMatches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** POST /debug/bumpers/apply - run the real bumper worker. */
export const bumperApply = async (req, res) => {
  try {
    const code = await runWorker("./src/worker/bumper.ts", null);
    res.json({ exitCode: code, milvusReadonly: config.milvusReadonly });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};

/** GET /debug/milvus/file/:fileId - how many vectors a file still has indexed. */
export const milvusFile = async (req, res) => {
  try {
    const fileId = Number(req.params.fileId);
    const counted = await req.app.locals.milvus.query({
      collection_name: "frame_color_layout",
      filter: `file_id == ${fileId}`,
      output_fields: ["count(*)"],
    });
    const sample = await req.app.locals.milvus.query({
      collection_name: "frame_color_layout",
      filter: `file_id == ${fileId}`,
      output_fields: ["time"],
      limit: 16384,
    });
    const times = (sample.data ?? []).map((e: any) => e.time).sort((a, b) => a - b);
    const [row] = await sql`
      SELECT
        path,
        frame_count,
        duration,
        loaded,
        segment_type
      FROM
        files
      WHERE
        id = ${fileId}
    `;
    res.json({
      fileId,
      file: row ?? null,
      milvusCount: Number(counted.data?.[0]?.["count(*)"] ?? 0),
      sampled: times.length,
      minTime: times[0] ?? null,
      maxTime: times[times.length - 1] ?? null,
      // the largest hole in the indexed timeline, i.e. where a segment was pruned
      largestGap: times.reduce(
        (max, time, i) => (i === 0 ? max : Math.max(max, time - times[i - 1])),
        0,
      ),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error) });
  }
};
