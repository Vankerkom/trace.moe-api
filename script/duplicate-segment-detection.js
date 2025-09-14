import "../env.js";
import { parseArgs } from "node:util";
import sql from "../sql.js";
import { findSegments, printSegments } from "./segment-helpers.js";
import { search } from "./milvus-helper.js";
import { getHashFileData } from "./hash-data.js";

const options = {
  input: { type: "string", short: "i" },
};

async function main(args) {
  if (!args.input) {
    console.warn("Incorrect usage: node duplicate-segment-detection.js -i 123/file.mp4");
    await sql.end();
    return;
  }

  const hashFile = await getHashFileData(args.input);

  await sql.end();

  if (!hashFile) {
    return;
  }

  let searchFilter = `anilist_id == ${hashFile.anilistId}`;

  if (hashFile.fileId) {
    searchFilter += ` and file_id != ${hashFile.fileId}`;
  }

  let hashes = hashFile.hashes.filter((frame, index) => index % 3 === 0);

  const results = await search(hashes, searchFilter, 1);
  const segments = findSegments(hashes, results, 1.0, 3.0, 30.0);
  printSegments(segments);

  const lastFrame = hashFile.hashes[hashFile.hashes.length - 1].time;
  console.log("lastFrame", lastFrame);
  const potentialOpenings = segments.filter((segment) => segment[0] <= lastFrame * 0.6);
  const potentialEndings = segments.filter((segment) => segment[0] > lastFrame * 0.5);

  printSegments(potentialOpenings, "Potential Opening");
  printSegments(potentialEndings, "Potential Ending");
}

const { values, _ } = parseArgs({ options });

main(values);
