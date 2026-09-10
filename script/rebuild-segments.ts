// One-off: revert every existing dedup segment (removing it from Milvus and
// files, restoring the ranges it had pruned from source episodes), then
// re-run detection + extraction so segments are re-cut with the new x265
// 10-bit encoding settings. Run with the indexing server stopped, and start
// it again afterwards so media-info/scene-changes/color-layout/milvus-load
// pick up the freshly extracted segment files.
import { Worker } from "node:worker_threads";

import { MilvusClient } from "@zilliz/milvus2-sdk-node";

import "../env.ts";
import sql from "../sql.ts";
import { revertSegment } from "../src/lib/segment-extract.ts";

const { MILVUS_ADDR, MILVUS_TOKEN } = process.env;
const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });

const runWorker = (file: string, workerData: any) =>
  new Promise<number>((resolve) => {
    const worker = new Worker(file, { workerData });
    worker.on("error", (error) => console.error(error));
    worker.on("exit", (code) => resolve(code ?? 1));
  });

const segments = await sql`
  SELECT DISTINCT
    id,
    anilist_id
  FROM
    files
  WHERE
    segment_type IS NOT NULL
  ORDER BY
    id
`;

console.info(`[rebuild-segments] reverting ${segments.length} segment(s)`);
for (const segment of segments) {
  console.info(`[rebuild-segments][revert] ${segment.id} (anilist ${segment.anilist_id})`);
  const result = await revertSegment(milvus, segment.id);
  console.info(`[rebuild-segments][revert] ${segment.id} ->`, result);
}

// revertSegment resets loaded = NULL on every restored source episode so the
// ordinary milvus-load stage re-inserts them from files.color_layout - but
// that stage only runs inside the server's TaskManager, which isn't running
// here, so reload them directly before dedup can see them again.
const pending = await sql`
  SELECT
    id,
    path
  FROM
    files
  WHERE
    loaded IS NULL
    AND segment_type IS NULL
    AND color_layout IS NOT NULL
`;
console.info(`[rebuild-segments] reloading ${pending.length} restored file(s) into milvus`);
const CONCURRENCY = 4;
for (let i = 0; i < pending.length; i += CONCURRENCY) {
  await Promise.all(
    pending
      .slice(i, i + CONCURRENCY)
      .map((file) =>
        runWorker("./src/worker/milvus-load.ts", { id: file.id, filePath: file.path }),
      ),
  );
}

const anilistIds = [...new Set(segments.map((e) => e.anilist_id))];
console.info(`[rebuild-segments] re-extracting for ${anilistIds.length} series`);
for (const anilistId of anilistIds) {
  console.info(`[rebuild-segments][dedup] anilist ${anilistId}`);
  const code = await runWorker("./src/worker/dedup.ts", { anilistId, force: true });
  console.info(`[rebuild-segments][dedup] anilist ${anilistId} exit ${code}`);
}

await sql.end();
console.info("[rebuild-segments] done - start the server to index the new segment files");
