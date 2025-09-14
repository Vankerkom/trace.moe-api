import "../env.js";

import sql from "../sql.js";
import aniep from "aniep";

const WINDOW_SIZE = 1_000;

async function main() {
  const [row] = await sql`
    SELECT
      count(id) AS count
    FROM
      files
  `;
  let filesProcessed = 0;

  console.log(`Parsing episode numbers of ${row.count} files...`);

  while (true) {
    const files = await sql`
      SELECT
        id,
        path
      FROM
        files
      ORDER BY
        id
      LIMIT
        ${WINDOW_SIZE}
      OFFSET
        ${filesProcessed}
    `;

    if (!files.length) {
      break;
    }

    filesProcessed += files.length;

    // For now, if it's not a number, we ignore it.
    const parsedFiles = files
      .map((file) => ({ id: file.id, episode: aniep(file.path.split("/").pop()) }))
      .filter((file) => Number.isSafeInteger(file.episode));

    const fileIds = parsedFiles.map((file) => file.id);
    const fileEpisodes = parsedFiles.map((file) => Number(file.episode));

    await sql`
      UPDATE files
      SET
        episode = data.episode
      FROM
        (
          SELECT
            UNNEST(${fileIds}::int[]) AS id,
            UNNEST(${fileEpisodes}::smallint[]) AS episode
        ) AS data
      WHERE
        files.id = data.id
    `;

    console.log(`Parsed ${filesProcessed} files...`);
  }

  console.log("File episode parsing completed.");

  await sql.end();
}

main();
