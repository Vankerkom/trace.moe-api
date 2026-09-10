// One-off companion to rebuild-segments.ts: re-run dedup detection/extraction
// for a fixed list of anilist ids after their source episodes have already
// been reloaded into milvus.
import { Worker } from "node:worker_threads";

import "../env.ts";

const ids = [101280, 108511, 176301, 161645, 130003, 150672, 139095, 98977];

const runWorker = (file: string, workerData: any) =>
  new Promise<number>((resolve) => {
    const worker = new Worker(file, { workerData });
    worker.on("error", (error) => console.error(error));
    worker.on("exit", (code) => resolve(code ?? 1));
  });

for (const anilistId of ids) {
  console.info(`[dedup] anilist ${anilistId}`);
  const code = await runWorker("./src/worker/dedup.ts", { anilistId, force: true });
  console.info(`[dedup] anilist ${anilistId} exit ${code}`);
}
