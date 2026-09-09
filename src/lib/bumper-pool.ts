import fs from "node:fs/promises";
import path from "node:path";

import { ColorLayout } from "trace.moe-id";

import prepareSearchImage from "./prepare-search-image.ts";
import { config, SEGMENT_TYPES } from "./segment-config.ts";
import { searchProbes } from "./segment-detect.ts";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export interface Bumper {
  label: string;
  file: string;
  vector: number[];
}

// hashes are cached for the lifetime of the process, keyed so that replacing an
// image on disk invalidates its entry
const cache = new Map<string, Bumper>();

const slugify = (name: string) =>
  path
    .parse(name)
    .name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Hash every still in the pool directory, reusing cached vectors for unchanged files. */
export const loadBumperPool = async (): Promise<Bumper[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(config.bumperPath);
  } catch {
    return [];
  }

  const bumpers: Bumper[] = [];
  for (const name of entries) {
    if (!IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
    const file = path.join(config.bumperPath, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;

    const key = `${name}:${stat.mtimeMs}:${stat.size}`;
    const cached = cache.get(key);
    if (cached) {
      bumpers.push(cached);
      continue;
    }

    try {
      const image = await prepareSearchImage(await fs.readFile(file), false);
      const bumper: Bumper = {
        label: slugify(name),
        file: name,
        vector: ColorLayout.extract({
          data: image.data,
          width: image.info.width,
          height: image.info.height,
          channels: 3,
        }),
      };
      // drop the previous hash of this same image, if it was replaced
      for (const [oldKey, value] of cache) {
        if (value.file === name) cache.delete(oldKey);
      }
      cache.set(key, bumper);
      bumpers.push(bumper);
    } catch (error) {
      console.error(`[bumper][error] ${name}: ${error}`);
    }
  }
  return bumpers;
};

export const cachedBumpers = () => [...cache.values()];

export interface BumperMatch {
  file_id: number;
  start_time: number;
  end_time: number;
  score: number;
}

/**
 * Find every indexed video whose opening seconds contain this still. A branding
 * bumper is a held logo, so a single still matches a contiguous run of frames.
 */
export const matchBumper = async (
  milvus: any,
  bumper: Bumper,
  excludeFileIds: Set<number> = new Set(),
): Promise<BumperMatch[]> => {
  const typeConfig = SEGMENT_TYPES.branding;
  const [hits] = await searchProbes(milvus, [{ time: 0, vector: bumper.vector }], null);

  const byFile = new Map<number, { time: number; score: number }[]>();
  for (const hit of hits) {
    if (hit.time > typeConfig.headWindow) continue;
    // an already-extracted segment must never become the source of another one
    if (excludeFileIds.has(hit.file_id)) continue;
    const list = byFile.get(hit.file_id);
    if (list) list.push(hit);
    else byFile.set(hit.file_id, [hit]);
  }

  const matches: BumperMatch[] = [];
  for (const [fileId, list] of byFile) {
    list.sort((a, b) => a.time - b.time);
    let run: { start: number; end: number; scores: number[] } | null = null;
    let best: typeof run = null;
    for (const hit of list) {
      if (run && hit.time - run.end <= config.gapTolerance) {
        run.end = hit.time;
        run.scores.push(hit.score);
      } else {
        run = { start: hit.time, end: hit.time, scores: [hit.score] };
      }
      if (!best || run.end - run.start > best.end - best.start) best = run;
    }
    if (!best) continue;
    const duration = best.end - best.start;
    if (duration < typeConfig.minDuration || duration > typeConfig.maxDuration) continue;
    matches.push({
      file_id: fileId,
      start_time: best.start,
      end_time: best.end,
      score: best.scores.reduce((sum, e) => sum + e, 0) / best.scores.length,
    });
  }
  return matches;
};
