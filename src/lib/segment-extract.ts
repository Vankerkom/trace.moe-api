import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import sql from "../../sql.ts";
import { config, segmentPath } from "./segment-config.ts";
import type { Candidate } from "./segment-detect.ts";

const VIDEO_PATH = path.normalize(process.env.VIDEO_PATH);

const throwOnMilvusError = (result: any, what: string) => {
  if (result?.status?.error_code && result.status.error_code !== "Success") {
    throw new Error(
      result.status.reason ||
        result.status.detail ||
        `Milvus ${what} error: ${result.status.error_code}`,
    );
  }
};

const videoHeight = (mediaInfo: any) =>
  mediaInfo?.streams?.find((e: any) => e.codec_type === "video")?.height ?? 0;

/** Cut [start, end] out of a source video, downscaling to 720p if the source is taller. */
export const cutSegment = (
  sourcePath: string,
  outputPath: string,
  start: number,
  duration: number,
  height: number,
) =>
  new Promise<number>((resolve) => {
    const ffmpeg = child_process.spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-y",
      "-ss",
      `${start}`,
      "-i",
      sourcePath,
      "-t",
      `${duration}`,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      ...(height > 720 ? ["-vf", "scale=-2:720"] : []),
      "-c:v",
      "libx265",
      "-crf",
      "19",
      "-preset",
      "slow",
      "-x265-params",
      "limit-sao:bframes=8:psy-rd=1:aq-mode=3",
      "-pix_fmt",
      "yuv420p10le",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "128k",
      "-max_muxing_queue_size",
      "1024",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      outputPath,
    ]);
    ffmpeg.stderr.on("data", (data) => console.log(data.toString()));
    ffmpeg.on("error", (error) => {
      console.error(`[segment-extract][error] ${error}`);
      resolve(1);
    });
    ffmpeg.on("close", (code) => resolve(code ?? 1));
  });

/**
 * Materialise a detected candidate: insert the synthetic files row, cut the
 * video, then record which episodes it was extracted from. The row is left for
 * the ordinary media-info / scene-changes / color-layout / milvus-load stages
 * to index, exactly like any other file.
 */
export const extractSegment = async (candidate: Candidate) => {
  const [reference] = await sql`
    SELECT
      path,
      media_info
    FROM
      files
    WHERE
      id = ${candidate.reference_file_id}
  `;
  if (!reference) throw new Error(`reference file ${candidate.reference_file_id} is gone`);

  // reserve the id up front: the filename embeds it, and the row must not exist
  // before the file does or the media-info/color-layout stages would pick up a
  // path that ffmpeg is still writing
  const [{ nextval: reservedId }] = await sql`
    SELECT
      nextval('files_id_seq')
  `;
  const segmentFileId = Number(reservedId);

  const relativePath = segmentPath(
    candidate.anilist_id,
    candidate.type,
    segmentFileId,
    candidate.reference_file_id,
  );
  const outputPath = path.join(VIDEO_PATH, relativePath);

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    console.info(
      `[segment-extract][doing] ${reference.path} start=${candidate.start.toFixed(1)}s ` +
        `duration=${candidate.duration.toFixed(1)}s -> ${relativePath}`,
    );
    const startExtract = performance.now();
    const code = await cutSegment(
      path.join(VIDEO_PATH, reference.path),
      outputPath,
      candidate.start,
      candidate.duration,
      videoHeight(reference.media_info),
    );
    const extractMs = (performance.now() - startExtract) | 0;
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
    console.info(`[segment-extract][done]  ${relativePath} in ${extractMs}ms`);

    await sql`
      INSERT INTO
        files ${sql({
          id: segmentFileId,
          anilist_id: candidate.anilist_id,
          path: relativePath,
          segment_type: candidate.type,
          segment_reference_id: candidate.reference_file_id,
        })}
    `;

    await sql`
      INSERT INTO
        segment_matches ${sql(
          candidate.matches.map((e) => ({
            segment_file_id: segmentFileId,
            file_id: e.file_id,
            start_time: e.start_time,
            end_time: e.end_time,
            score: e.score,
          })),
        )}
      ON CONFLICT (segment_file_id, file_id) DO NOTHING
    `;
  } catch (error) {
    // leave nothing half-created behind
    await sql`
      DELETE FROM files
      WHERE
        id = ${segmentFileId}
    `;
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }

  return { segmentFileId, relativePath };
};

/**
 * Delete the redundant vectors. Only ever runs for segments whose synthetic
 * file is already queryable in Milvus, so the content stays searchable
 * throughout. files.color_layout is untouched, so this is reversible.
 */
export const pruneMatches = async (milvus: any, segmentFileId: number | null = null) => {
  const pending = await sql`
    SELECT
      m.id,
      m.file_id,
      m.start_time,
      m.end_time
    FROM
      segment_matches m
      JOIN files s ON s.id = m.segment_file_id
    WHERE
      m.milvus_deleted = FALSE
      AND s.loaded = TRUE ${segmentFileId === null
        ? sql``
        : sql`AND m.segment_file_id = ${segmentFileId}`}
  `;

  if (pending.length === 0) return { pruned: 0, skipped: 0 };
  if (config.milvusReadonly) {
    console.info(`[dedup] DEDUP_MILVUS_READONLY set, skipping ${pending.length} range deletes`);
    return { pruned: 0, skipped: pending.length };
  }

  console.info(
    `[prune][doing] segment ${segmentFileId ?? "*"} ${pending.length} pending range deletes`,
  );
  const startPrune = performance.now();
  let pruned = 0;
  let skipped = 0;

  for (const match of pending) {
    const start = match.start_time + config.pruneMargin;
    const end = match.end_time - config.pruneMargin;
    if (end <= start) {
      skipped++;
      continue;
    }
    const result = await milvus.delete({
      collection_name: "frame_color_layout",
      filter: `file_id == ${match.file_id} and time >= ${start} and time <= ${end}`,
    });
    throwOnMilvusError(result, "delete");
    await sql`
      UPDATE segment_matches
      SET
        milvus_deleted = TRUE
      WHERE
        id = ${match.id}
    `;
    pruned++;
  }

  const pruneMs = (performance.now() - startPrune) | 0;
  console.info(
    `[prune][done]  segment ${segmentFileId ?? "*"} pruned=${pruned} skipped=${skipped} in ${pruneMs}ms`,
  );

  return { pruned, skipped };
};

/**
 * Undo a segment: drop the synthetic file and let the ordinary milvus-load
 * stage rebuild every episode it was pruned from out of files.color_layout.
 */
export const revertSegment = async (milvus: any, segmentFileId: number) => {
  const [segment] = await sql`
    SELECT
      id,
      path
    FROM
      files
    WHERE
      id = ${segmentFileId}
      AND segment_type IS NOT NULL
  `;
  if (!segment) return null;

  const matches = await sql`
    SELECT
      file_id
    FROM
      segment_matches
    WHERE
      segment_file_id = ${segmentFileId}
      AND milvus_deleted = TRUE
  `;

  for (const match of matches) {
    const result = await milvus.delete({
      collection_name: "frame_color_layout",
      filter: `file_id == ${match.file_id}`,
    });
    throwOnMilvusError(result, "delete");
  }

  const segmentDelete = await milvus.delete({
    collection_name: "frame_color_layout",
    filter: `file_id == ${segmentFileId}`,
  });
  throwOnMilvusError(segmentDelete, "delete");

  const restoredIds = matches.map((e) => e.file_id);
  if (restoredIds.length > 0) {
    await sql`
      UPDATE files
      SET
        loaded = NULL,
        updated = now()
      WHERE
        id IN ${sql(restoredIds)}
    `;
    // these files are rebuilt in full, which also restores the ranges other
    // segments had pruned from them - queue those ranges to be pruned again
    await sql`
      UPDATE segment_matches
      SET
        milvus_deleted = FALSE
      WHERE
        file_id IN ${sql(restoredIds)}
        AND segment_file_id <> ${segmentFileId}
    `;
  }

  // segment_matches rows cascade with the file row
  await sql`
    DELETE FROM files
    WHERE
      id = ${segmentFileId}
  `;
  // only files this stage created are ours to delete - a branding clip is
  // indexed in place from the user's own directory and has to survive a revert
  if (segment.path.split("/")[0] === config.segmentDir) {
    await fs.rm(path.join(VIDEO_PATH, segment.path), { force: true }).catch(() => {});
  }

  return { segmentFileId, restored: restoredIds };
};
