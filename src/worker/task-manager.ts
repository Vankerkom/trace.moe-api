import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import aniep from "aniep";

import sql from "../../sql.ts";
import { parseEpisodeRange } from "../lib/parse-episode.ts";
import { config } from "../lib/segment-config.ts";

const VIDEO_PATH = path.normalize(process.env.VIDEO_PATH);
const MAX_WORKER = Number(process.env.MAX_WORKER) || 1;

export default class TaskManager {
  scanTimer: NodeJS.Timeout;

  isScanTaskRunning = false;

  async runScanTask(interval: number) {
    if (!interval || !Number.isFinite(interval) || interval <= 0) return;
    if (this.isScanTaskRunning) return;
    this.isScanTaskRunning = true;
    try {
      clearTimeout(this.scanTimer);
      console.info(`[scan][doing] ${VIDEO_PATH}`);
      const startScan = performance.now();

      const [dbSet, fileList] = await Promise.all([
        sql`
          SELECT
            path
          FROM
            files
        `.then((e) => new Set(e.map((e) => e.path))),
        fs.readdir(VIDEO_PATH, { recursive: true, withFileTypes: true }).then((e) =>
          e
            .filter(
              (e) =>
                e.isFile() &&
                // note: this only accepts files directly under a numeric dir, so
                // extracted segments (segments/<anilist_id>/) are never picked up
                path.relative(VIDEO_PATH, e.parentPath).match(/^\d+$/) &&
                [".webm", ".mkv", ".mp4"].includes(path.extname(e.name)),
            )
            .map((e) => path.join(path.relative(VIDEO_PATH, e.parentPath), e.name)),
        ),
      ]);

      const newFileList = fileList.filter((e) => !dbSet.has(e));
      console.info(
        `[scan] found ${fileList.length} files on disk, ${dbSet.size} already known, ` +
          `${newFileList.length} new`,
      );

      for (let i = 0; i < newFileList.length; i += 10000) {
        await sql`
          INSERT INTO
            files ${sql(
              newFileList.slice(i, i + 10000).map((e) => {
                const { episode_start, episode_end } = parseEpisodeRange(aniep(path.basename(e)));
                return {
                  anilist_id: Number(path.parse(e).dir),
                  episode_start,
                  episode_end,
                  path: e,
                };
              }),
            )}
        `;
      }

      const scanMs = (performance.now() - startScan) | 0;
      console.info(`[scan][done]  ${VIDEO_PATH} added=${newFileList.length} in ${scanMs}ms`);

      this.runAnilistTask();
      this.runCrc32Task();
      this.runMediaInfoTask();
      this.runSceneChangesTask();
      this.runColorLayoutTask();
      this.runMilvusLoadTask();
      this.runDedupTask();
      this.runBumperTask();
    } catch (error) {
      console.error(error);
    } finally {
      this.isScanTaskRunning = false;
      if (interval) this.scanTimer = setTimeout(() => this.runScanTask(interval), interval * 1000);
    }
  }

  stopScanTask() {
    clearTimeout(this.scanTimer);
  }

  isAnilistTaskRunning = false;

  async runAnilistTask() {
    try {
      const rows = await sql`
        SELECT DISTINCT
          anilist_id
        FROM
          files
        WHERE
          anilist_id NOT IN (
            SELECT
              id
            FROM
              anilist
            WHERE
              NOT COALESCE((json ->> 'placeholder')::boolean, FALSE)
              OR updated > now() - INTERVAL '4 hours'
          )
      `;
      if (rows.length === 0 || this.isAnilistTaskRunning) return;
      this.isAnilistTaskRunning = true;
      const worker = new Worker("./src/worker/anilist.ts", {
        workerData: { ids: rows.map((e) => e.anilist_id) },
      });
      worker.on("error", (error) => console.error(error));
      worker.on("exit", () => {
        this.isAnilistTaskRunning = false;
        this.runAnilistTask();
        this.runMilvusLoadTask();
      });
    } catch (error) {
      console.error(error);
    }
  }

  mediaInfoTaskList = new Map<number, any>();
  mediaInfoTaskListMax = MAX_WORKER;

  async runMediaInfoTask() {
    if (this.mediaInfoTaskList.size >= this.mediaInfoTaskListMax) return;
    try {
      for (const { id, path: relativePath } of await sql`
        SELECT
          id,
          path
        FROM
          files
        WHERE
          media_info IS NULL
        ORDER BY
          id DESC
        LIMIT
          ${this.mediaInfoTaskListMax}
      `) {
        const filePath = path.join(VIDEO_PATH, relativePath);
        if (this.mediaInfoTaskList.has(id)) continue;
        const worker = new Worker("./src/worker/media-info.ts", {
          workerData: { id, filePath },
        });
        worker.on("error", (error) => console.error(error));
        worker.on("exit", () => {
          this.mediaInfoTaskList.delete(id);
          this.publish();
          this.runMediaInfoTask();
          this.runMilvusLoadTask();
        });
        this.mediaInfoTaskList.set(id, { id, filePath, worker });
        this.publish();
      }
    } catch (error) {
      console.error(error);
    }
  }

  sceneChangesTaskList = new Map<number, any>();
  sceneChangesTaskListMax = MAX_WORKER;

  async runSceneChangesTask() {
    if (this.sceneChangesTaskList.size >= this.sceneChangesTaskListMax) return;
    try {
      for (const { id, path: relativePath } of await sql`
        SELECT
          id,
          path
        FROM
          files
        WHERE
          scene_changes IS NULL
        ORDER BY
          id DESC
        LIMIT
          ${this.sceneChangesTaskListMax}
      `) {
        const filePath = path.join(VIDEO_PATH, relativePath);
        if (this.sceneChangesTaskList.has(id)) continue;
        const worker = new Worker("./src/worker/scene-changes.ts", {
          workerData: { id, filePath },
        });
        worker.on("error", (error) => console.error(error));
        worker.on("exit", () => {
          this.sceneChangesTaskList.delete(id);
          this.publish();
          this.runSceneChangesTask();
          this.runMilvusLoadTask();
        });
        this.sceneChangesTaskList.set(id, { id, filePath, worker });
        this.publish();
      }
    } catch (error) {
      console.error(error);
    }
  }

  colorLayoutTaskList = new Map<number, any>();
  colorLayoutTaskListMax = MAX_WORKER;

  async runColorLayoutTask() {
    if (this.colorLayoutTaskList.size >= this.colorLayoutTaskListMax) return;
    try {
      for (const { id, path: relativePath } of await sql`
        SELECT
          id,
          path
        FROM
          files
        WHERE
          color_layout IS NULL
        ORDER BY
          id DESC
        LIMIT
          ${this.colorLayoutTaskListMax}
      `) {
        const filePath = path.join(VIDEO_PATH, relativePath);
        if (this.colorLayoutTaskList.has(id)) continue;
        const worker = new Worker("./src/worker/color-layout.ts", {
          workerData: { id, filePath },
        });
        worker.on("error", (error) => console.error(error));
        worker.on("exit", () => {
          this.colorLayoutTaskList.delete(id);
          this.publish();
          this.runColorLayoutTask();
          this.runMilvusLoadTask();
        });
        this.colorLayoutTaskList.set(id, { id, filePath, worker });
        this.publish();
      }
    } catch (error) {
      console.error(error);
    }
  }

  milvusLoadTaskList = new Map<number, any>();
  milvusLoadTaskListMax = MAX_WORKER;

  async runMilvusLoadTask() {
    if (this.milvusLoadTaskList.size >= this.milvusLoadTaskListMax) return;
    try {
      for (const { id, path: relativePath } of await sql`
        SELECT
          id,
          path
        FROM
          files
        WHERE
          loaded IS NULL
          AND media_info IS NOT NULL
          AND scene_changes IS NOT NULL
          AND color_layout IS NOT NULL
          AND anilist_id IN (
            SELECT
              id
            FROM
              anilist
          )
        ORDER BY
          id DESC
        LIMIT
          ${this.milvusLoadTaskListMax}
      `) {
        const filePath = path.join(VIDEO_PATH, relativePath);
        if (this.milvusLoadTaskList.has(id)) continue;
        const worker = new Worker("./src/worker/milvus-load.ts", {
          workerData: { id, filePath },
        });
        worker.on("error", (error) => console.error(error));
        worker.on("exit", () => {
          this.milvusLoadTaskList.delete(id);
          this.publish();
          this.runMilvusLoadTask();
          this.runDedupTask();
        });
        this.milvusLoadTaskList.set(id, { id, filePath, worker });
        this.publish();
      }
    } catch (error) {
      console.error(error);
    }
  }

  dedupTaskList = new Map<number, any>();
  dedupTaskListMax = MAX_WORKER;

  async runDedupTask() {
    if (!config.enabled) return;
    if (this.dedupTaskList.size >= this.dedupTaskListMax) return;
    try {
      // a series is due when it has never been analysed, or when the number of
      // indexed episodes changed since the last analysis
      for (const { anilist_id: anilistId } of await sql`
        SELECT
          f.anilist_id
        FROM
          files f
          LEFT JOIN dedup_runs d ON d.anilist_id = f.anilist_id
        WHERE
          f.loaded = TRUE
          AND f.segment_type IS NULL
        GROUP BY
          f.anilist_id,
          d.loaded_file_count
        HAVING
          count(*) > ${config.minSupport}
          AND (
            d.loaded_file_count IS NULL
            OR d.loaded_file_count <> count(*) ${
              // a reverted or re-indexed file comes back with the ranges other
              // segments had pruned from it, so those need pruning again
              config.milvusReadonly
                ? sql``
                : sql`
                    OR EXISTS (
                      SELECT
                        1
                      FROM
                        segment_matches m
                        JOIN files s ON s.id = m.segment_file_id
                      WHERE
                        s.anilist_id = f.anilist_id
                        AND s.loaded = TRUE
                        AND m.milvus_deleted = FALSE
                    )
                  `
            }
          )
        ORDER BY
          f.anilist_id DESC
        LIMIT
          ${this.dedupTaskListMax}
      `) {
        if (this.dedupTaskList.has(anilistId)) continue;
        const worker = new Worker("./src/worker/dedup.ts", {
          workerData: { anilistId },
        });
        worker.on("error", (error) => console.error(error));
        worker.on("exit", () => {
          this.dedupTaskList.delete(anilistId);
          this.publish();
          this.runDedupTask();
          // the extracted segment is a new file and needs indexing itself
          this.runMediaInfoTask();
          this.runSceneChangesTask();
          this.runColorLayoutTask();
          this.runMilvusLoadTask();
        });
        this.dedupTaskList.set(anilistId, {
          id: anilistId,
          filePath: `anilist ${anilistId}`,
          worker,
        });
        this.publish();
      }
    } catch (error) {
      console.error(error);
    }
  }

  isBumperTaskRunning = false;

  async runBumperTask() {
    if (!config.enabled) return;
    if (this.isBumperTaskRunning) return;
    try {
      this.isBumperTaskRunning = true;
      const worker = new Worker("./src/worker/bumper.ts");
      worker.on("error", (error) => console.error(error));
      worker.on("exit", () => {
        this.isBumperTaskRunning = false;
        this.publish();
        this.runMediaInfoTask();
        this.runSceneChangesTask();
        this.runColorLayoutTask();
        this.runMilvusLoadTask();
      });
      this.publish();
    } catch (error) {
      this.isBumperTaskRunning = false;
      console.error(error);
    }
  }

  crc32TaskList = new Map<number, any>();
  crc32TaskListMax = MAX_WORKER;

  async runCrc32Task() {
    if (this.crc32TaskList.size >= this.crc32TaskListMax) return;
    try {
      for (const { id, path: relativePath } of await sql`
        SELECT
          id,
          path
        FROM
          files
        WHERE
          crc32 IS NULL
        ORDER BY
          id DESC
        LIMIT
          ${this.crc32TaskListMax}
      `) {
        const filePath = path.join(VIDEO_PATH, relativePath);
        if (this.crc32TaskList.has(id)) continue;
        const worker = new Worker("./src/worker/crc32.ts", {
          workerData: { id, filePath },
        });
        worker.on("error", (error) => console.error(error));
        worker.on("exit", () => {
          this.crc32TaskList.delete(id);
          this.publish();
          this.runCrc32Task();
        });
        this.crc32TaskList.set(id, { id, filePath, worker });
        this.publish();
      }
    } catch (error) {
      console.error(error);
    }
  }

  sseClients = new Set<ServerResponse>();

  subscribe(res) {
    res.on("close", () => {
      this.sseClients.delete(res);
    });
    res.on("error", () => {
      this.sseClients.delete(res);
    });
    this.sseClients.add(res);
    this.publish();
  }

  publishTimer: NodeJS.Timeout;

  publish() {
    clearTimeout(this.publishTimer);
    const tasks = {
      crc32TaskList: Array.from(this.crc32TaskList.values()).map((e) => e.filePath),
      mediaInfoTaskList: Array.from(this.mediaInfoTaskList.values()).map((e) => e.filePath),
      sceneChangesTaskList: Array.from(this.sceneChangesTaskList.values()).map((e) => e.filePath),
      colorLayoutTaskList: Array.from(this.colorLayoutTaskList.values()).map((e) => e.filePath),
      milvusLoadTaskList: Array.from(this.milvusLoadTaskList.values()).map((e) => e.filePath),
      dedupTaskList: Array.from(this.dedupTaskList.values()).map((e) => e.filePath),
      bumperTaskList: this.isBumperTaskRunning ? [config.bumperPath] : [],
    };
    for (const client of this.sseClients) {
      client.write(`data: ${JSON.stringify(tasks)}\n\n`);
    }
    this.publishTimer = setTimeout(() => this.publish(), 30000); // keep alive to prevent cloudflare timeout
  }
}
