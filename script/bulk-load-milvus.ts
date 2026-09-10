import { promisify } from "node:util";
import zlib from "node:zlib";

import { MilvusClient } from "@zilliz/milvus2-sdk-node";

import "../env.ts";
import sql from "../sql.ts";
import { dedupeHashList } from "../src/lib/dedupe-hash-list.ts";

const zstdDecompress = promisify(zlib.zstdDecompress);

const { MILVUS_ADDR, MILVUS_TOKEN } = process.env;

const BATCH_SIZE = Number.parseInt(process.argv[2] || "500", 10);

const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });

let totalProcessed = 0;

try {
  while (true) {
    const rows = await sql`
      SELECT
        id,
        path,
        color_layout
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
        ${BATCH_SIZE}
    `;

    if (rows.length === 0) {
      console.log("No more pending files to load into Milvus.");
      break;
    }

    const batchData: Array<{ file_id: number; time: number; vector: number[] }> = [];
    const loadedFileIds: number[] = [];

    for (const row of rows) {
      try {
        const decompressed = await zstdDecompress(row.color_layout);
        const hashList = JSON.parse(decompressed.toString());
        const deduped = dedupeHashList(hashList);

        for (const frame of deduped) {
          batchData.push({
            file_id: row.id,
            time: frame.time,
            vector: frame.vector,
          });
        }
        loadedFileIds.push(row.id);
      } catch (err) {
        console.error(`Failed to process video file ID ${row.id}:`, err);
        await sql`
          UPDATE files
          SET
            loaded = false
          WHERE
            id = ${row.id}
        `;
      }
    }

    const MAX_VECTORS_PER_INSERT = 100000;

    if (loadedFileIds.length > 0 && batchData.length > 0) {
      console.log(
        `Inserting batch of ${loadedFileIds.length} files (${batchData.length} vectors) into Milvus...`,
      );

      try {
        for (let i = 0; i < batchData.length; i += MAX_VECTORS_PER_INSERT) {
          const chunk = batchData.slice(i, i + MAX_VECTORS_PER_INSERT);
          const result = await milvus.insert({
            collection_name: "frame_color_layout",
            data: chunk,
          });
          if (result?.status?.error_code && result.status.error_code !== "Success") {
            throw new Error(
              result.status.reason ||
                result.status.detail ||
                `Milvus error: ${result.status.error_code}`,
            );
          }
        }

        await sql`
          UPDATE files
          SET
            loaded = true
          WHERE
            id IN ${sql(loadedFileIds)}
        `;

        totalProcessed += loadedFileIds.length;
        console.log(
          `Successfully loaded ${loadedFileIds.length} files (total: ${totalProcessed}).`,
        );
      } catch (insertError) {
        console.error(`Failed to insert batch into Milvus:`, insertError);
        await sql`
          UPDATE files
          SET
            loaded = false
          WHERE
            id IN ${sql(loadedFileIds)}
        `;
      }
    }
  }
} finally {
  await milvus.closeConnection();
  await sql.end();
}
