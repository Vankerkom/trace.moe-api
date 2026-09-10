import path from "node:path";
import { promisify } from "node:util";
import { workerData } from "node:worker_threads";
import zlib from "node:zlib";

import { MilvusClient } from "@zilliz/milvus2-sdk-node";

import sql from "../../sql.ts";
import { dedupeHashList } from "../lib/dedupe-hash-list.ts";

const zstdDecompress = promisify(zlib.zstdDecompress);

const { MILVUS_ADDR, MILVUS_TOKEN, DISCORD_URL, TELEGRAM_ID, TELEGRAM_URL } = process.env;

const { id, filePath } = workerData;
console.info(`[milvus-load][doing] ${filePath}`);

const [row] = await sql`
  SELECT
    color_layout
  FROM
    files
  WHERE
    id = ${id}
`;

const dedupedHashList = dedupeHashList(
  JSON.parse((await zstdDecompress(row.color_layout)).toString()),
);

const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });

try {
  // loading must be idempotent: without this, anything that re-queues a file
  // (a failed load, a reverted segment) stacks a second copy of its vectors
  const cleared = await milvus.delete({
    collection_name: "frame_color_layout",
    filter: `file_id == ${id}`,
  });
  if (cleared?.status?.error_code && cleared.status.error_code !== "Success") {
    throw new Error(
      cleared.status.reason ||
        cleared.status.detail ||
        `Milvus error: ${cleared.status.error_code}`,
    );
  }

  const result = await milvus.insert({
    collection_name: "frame_color_layout",
    data: dedupedHashList.map(({ time, vector }) => ({ file_id: id, time, vector })),
  });
  if (result?.status?.error_code && result.status.error_code !== "Success") {
    throw new Error(
      result.status.reason || result.status.detail || `Milvus error: ${result.status.error_code}`,
    );
  }
  await sql`
    UPDATE files
    SET
      loaded = true
    WHERE
      id = ${id}
  `;

  if (TELEGRAM_ID && TELEGRAM_URL) {
    fetch(TELEGRAM_URL, {
      method: "POST",
      body: new URLSearchParams([
        ["chat_id", TELEGRAM_ID],
        ["parse_mode", "Markdown"],
        ["text", "`" + path.basename(filePath) + "`"],
      ]),
    });
  }

  if (DISCORD_URL) {
    fetch(DISCORD_URL, {
      method: "POST",
      body: new URLSearchParams([["content", path.basename(filePath)]]),
    });
  }
} catch (error) {
  console.error(`[milvus-load][error] ${error}`);
  await sql`
    UPDATE files
    SET
      loaded = false
    WHERE
      id = ${id}
  `;
}

await milvus.closeConnection();

await sql.end();

console.info(`[milvus-load][done]  ${filePath}`);
