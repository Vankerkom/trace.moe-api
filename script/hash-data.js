import path from "node:path";
import * as hashStorage from "../src/lib/hash-storage.js";
import sql from "../sql.js";

export async function getHashFileData(file) {
  let anilistId = Number(path.parse(file).dir);
  let hashes = [];

  try {
    hashes = await hashStorage.read(file);
  } catch {
    console.error(`Failed to read hash file ${hashStorage.getFilePath(file)}`);
    return null;
  }

  // Figure out if the file is already present in the database.
  const [row] = await sql`
    SELECT
      id
    FROM
      files
    WHERE
      path = ${file}
  `;

  let data = {
    fileId: row.id || null,
    file: file,
    anilistId,
    hashes,
  };

  return data;
}
