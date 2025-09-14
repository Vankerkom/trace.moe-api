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
    console.warn("Incorrect usage: node branding-detection.js -i 123/file.mp4");
    await sql.end();
    return;
  }

  const hashFile = await getHashFileData(args.input);

  await sql.end();

  if (!hashFile) {
    return;
  }

  // Branding occurs in the beginning of the video so we only need to search the beginning of the videos.
  // Grab the first 30 seconds of the video and compare it against other videos.
  // Make sure we don't compare it against the same series as it might overlap with intros.
  // Also make sure it's not itself if it already exists in the database.
  // TODO We can upgrade this by searching for multiple results and check against the result scores so there is no a single outlier.

  let searchFilter = `anilist_id != ${hashFile.anilistId} and time <= 30.0`;

  if (hashFile.fileId) {
    searchFilter += ` and file_id != ${hashFile.fileId}`;
  }

  const framesInSearchWindow = hashFile.hashes.filter((frame, index) => index % 8 === 0 && frame.time <= 30.0);
  console.log('framesInSearchWindow', framesInSearchWindow.length);
  const results = await search(framesInSearchWindow, searchFilter, 1);
  const segments = findSegments(framesInSearchWindow, results, 1.25, 1.0, 6.25);

  printSegments(segments);
}

const { values, _ } = parseArgs({ options });

main(values);
