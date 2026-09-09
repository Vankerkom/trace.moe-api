import { performance } from "node:perf_hooks";

import { MilvusClient } from "@zilliz/milvus2-sdk-node";

import sql from "../../sql.ts";
import { loadBumperPool, matchBumper } from "../lib/bumper-pool.ts";
import { config } from "../lib/segment-config.ts";
import { extractSegment, pruneMatches } from "../lib/segment-extract.ts";

const { MILVUS_ADDR, MILVUS_TOKEN } = process.env;

console.info(`[bumper][doing] ${config.bumperPath}`);

const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });

try {
  const bumpers = await loadBumperPool();
  if (bumpers.length === 0) console.info(`[bumper] no stills in ${config.bumperPath}`);

  const segmentIds = new Set<number>(
    (
      await sql`
        SELECT
          id
        FROM
          files
        WHERE
          segment_type IS NOT NULL
      `
    ).map((e) => e.id),
  );

  for (const bumper of bumpers) {
    const startTime = performance.now();
    const matches = await matchBumper(milvus, bumper, segmentIds);
    const detectMs = (performance.now() - startTime) | 0;

    if (matches.length < config.minSupport) {
      console.info(`[bumper] ${bumper.file} matched ${matches.length} files, below minimum`);
      continue;
    }

    const [existing] = await sql`
      SELECT
        id,
        anilist_id
      FROM
        files
      WHERE
        segment_type = 'branding'
        AND segment_label = ${bumper.label}
    `;

    if (existing) {
      // the still is already extracted - just link any newly indexed videos
      const linked = await sql`
        SELECT
          file_id
        FROM
          segment_matches
        WHERE
          segment_file_id = ${existing.id}
      `;
      const linkedIds = new Set(linked.map((e) => e.file_id));
      const added = matches.filter((e) => !linkedIds.has(e.file_id) && e.file_id !== existing.id);
      if (added.length > 0) {
        await sql`
          INSERT INTO
            segment_matches ${sql(
              added.map((e) => ({
                segment_file_id: existing.id,
                file_id: e.file_id,
                start_time: e.start_time,
                end_time: e.end_time,
                score: e.score,
              })),
            )}
          ON CONFLICT (segment_file_id, file_id) DO NOTHING
        `;
      }
      await pruneMatches(milvus, existing.id);
      console.info(
        `[bumper] ${bumper.file} +${added.length} files (${matches.length} total, ${detectMs}ms)`,
      );
      continue;
    }

    if (config.milvusReadonly) {
      console.info(
        `[bumper] ${bumper.file} matched ${matches.length} files in ${detectMs}ms, ` +
          `not extracting (DEDUP_MILVUS_READONLY)`,
      );
      continue;
    }

    // cut from whichever video holds the longest clean run of the still
    const reference = matches.reduce((best, e) =>
      e.end_time - e.start_time > best.end_time - best.start_time ? e : best,
    );
    const [referenceFile] = await sql`
      SELECT
        anilist_id
      FROM
        files
      WHERE
        id = ${reference.file_id}
    `;
    if (!referenceFile?.anilist_id) continue;

    const { segmentFileId, relativePath } = await extractSegment({
      type: "branding",
      anilist_id: referenceFile.anilist_id,
      reference_file_id: reference.file_id,
      start: reference.start_time,
      end: reference.end_time,
      duration: reference.end_time - reference.start_time,
      support: matches.length,
      score: reference.score,
      matches,
    });
    await sql`
      UPDATE files
      SET
        segment_label = ${bumper.label}
      WHERE
        id = ${segmentFileId}
    `;
    console.info(
      `[bumper] ${bumper.file} x${matches.length} files in ${detectMs}ms -> ${relativePath}`,
    );
  }
} catch (error) {
  console.error(`[bumper][error] ${error}`);
}

await milvus.closeConnection();

await sql.end();

console.info(`[bumper][done]  ${config.bumperPath}`);
