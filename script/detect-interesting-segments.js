import "../env.js";
import sql from "../sql.js";
import * as hashStorage from "../src/lib/hash-storage.js";
import { searchDirect } from "./milvus-helper.js";
import { findSegments, printSegments } from "./segment-helpers.js";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";

const { MILVUS_ADDR, MILVUS_TOKEN } = process.env;

async function main() {
  // Query all the files.
  const files = await sql`
    SELECT
      id,
      anilist_id,
      duration,
      path
    FROM
      files
    WHERE
      status = 'LOADED'
    ORDER BY
      id
  `;

  console.log("files", files);

  const _result = await sql`TRUNCATE intresting_segments RESTART IDENTITY`;

  const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });

  for (const fileRow of files) {
    console.log("fileRow", fileRow);

    let hashes = [];

    try {
      hashes = await hashStorage.read(fileRow.path);
    } catch {
      console.error(`Failed to read hash file ${hashStorage.getFilePath(fileRow.path)}`);
      return null;
    }

    if (!hashes.length) {
      console.warn(`Skipping ${fileRow.path} no hash file present`);
      continue;
    }

    // Opening / Ending
    console.log("hashes", hashes.length);
    const searchFilter = `anilist_id == ${fileRow.anilist_id} and file_id != ${fileRow.id}`;
    const openingEndingHashes = hashes.filter((frame, index) => index % 3 === 0);

    const results = await searchDirect(milvus, openingEndingHashes, searchFilter, 1);
    const segments = findSegments(openingEndingHashes, results, 1.0, 3.0, 60.0);
    const potentialOpenings = segments.filter((segment) => segment[0] <= fileRow.duration * 0.6);
    const potentialEndings = segments.filter((segment) => segment[0] > fileRow.duration * 0.5);

    printSegments(segments);
    printSegments(potentialOpenings, "Potential Opening");
    printSegments(potentialEndings, "Potential Ending");

    // Brand Detection
    const [openingSegment] = potentialOpenings;
    const openingStart = openingSegment ? openingSegment[0] ?? null : null;
    const openingEnd = openingSegment ? openingSegment[openingSegment.length - 1]  ?? null : null;

    const [endingSegment] = potentialEndings;
    const endingStart = endingSegment ? endingSegment[0] ?? null : null;
    const endingEnd = endingSegment ? endingSegment[endingSegment.length - 1]  ?? null : null;

    const _result = await sql`INSERT INTO intresting_segments(file_id, opening_start, opening_end, ending_start, ending_end) VALUES(${fileRow.id}, ${openingStart}, ${openingEnd}, ${endingStart}, ${endingEnd})`;
  }

  await milvus.closeConnection();
  await sql.end();
}

main();