import fs from "node:fs/promises";
import path from "node:path";

import { ColorLayout } from "trace.moe-id";

import prepareSearchImage from "./prepare-search-image.ts";
import { config, SEGMENT_TYPES } from "./segment-config.ts";
import { searchProbes } from "./segment-detect.ts";

const VIDEO_PATH = path.normalize(process.env.VIDEO_PATH);

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm"];

export interface BrandingItem {
  label: string;
  // the still used as the cheap "which episodes hold this at all" query
  imageFile: string;
  // the clip that *is* the segment, indexed in place and aligned frame by frame
  videoFile: string;
  // VIDEO_PATH-relative, i.e. what goes into files.path
  videoPath: string;
  vector: number[];
}

// hashes are cached for the lifetime of the process, keyed so that replacing an
// image on disk invalidates its entry
const cache = new Map<string, BrandingItem>();

const slugify = (name: string) =>
  path
    .parse(name)
    .name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Hash every image/video pair in the branding directory, reusing cached vectors
 * for unchanged stills. Both halves are required: the still finds the episodes,
 * the video pins down where the bumper starts and ends in each of them.
 */
export const loadBrandingPool = async (): Promise<BrandingItem[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(config.brandingPath);
  } catch {
    return [];
  }

  // group by basename, so funimation.png and funimation.mkv are one item
  const pairs = new Map<string, { image?: string; video?: string }>();
  for (const name of entries) {
    const extension = path.extname(name).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.includes(extension);
    const isVideo = VIDEO_EXTENSIONS.includes(extension);
    if (!isImage && !isVideo) continue;
    const stem = path.parse(name).name;
    const pair = pairs.get(stem) ?? {};
    if (isImage) pair.image = name;
    else pair.video = name;
    pairs.set(stem, pair);
  }

  const items: BrandingItem[] = [];
  for (const [stem, pair] of pairs) {
    if (!pair.image || !pair.video) {
      console.warn(
        `[branding] ${stem}: missing ${pair.image ? "video (.mp4/.mkv/.webm)" : "image (.png/.jpg/.webp)"}, skipped`,
      );
      continue;
    }

    const imagePath = path.join(config.brandingPath, pair.image);
    const stat = await fs.stat(imagePath).catch(() => null);
    if (!stat?.isFile()) continue;

    const key = `${pair.image}:${stat.mtimeMs}:${stat.size}`;
    const cached = cache.get(key);
    if (cached && cached.videoFile === pair.video) {
      items.push(cached);
      continue;
    }

    try {
      const image = await prepareSearchImage(await fs.readFile(imagePath), false);
      if (!image) throw new Error("could not be decoded");
      const item: BrandingItem = {
        label: slugify(pair.image),
        imageFile: pair.image,
        videoFile: pair.video,
        videoPath: path
          .relative(VIDEO_PATH, path.join(config.brandingPath, pair.video))
          .split(path.sep)
          .join("/"),
        vector: ColorLayout.extract({
          data: image.data,
          width: image.info.width,
          height: image.info.height,
          channels: 3,
        }),
      };
      // drop the previous hash of this same image, if it was replaced
      for (const [oldKey, value] of cache) {
        if (value.imageFile === pair.image) cache.delete(oldKey);
      }
      cache.set(key, item);
      items.push(item);
    } catch (error) {
      console.error(`[branding][error] ${pair.image}: ${error}`);
    }
  }
  return items;
};

export const cachedBranding = () => [...cache.values()];

/**
 * Every indexed video whose opening seconds contain this still. One probe
 * against the whole collection is capped at config.searchLimit hits, which a
 * studio logo blows straight through, so keep re-querying with what has already
 * been found excluded until a round turns up nothing new.
 */
export const discoverCandidates = async (
  milvus: any,
  item: BrandingItem,
  excludeFileIds: Set<number> = new Set(),
): Promise<number[]> => {
  const headWindow = SEGMENT_TYPES.branding.headWindow;
  const found = new Set<number>();
  // every file the probe has already reported, in or out of the head window -
  // excluding all of them is what lets the next round see past the hit limit
  const exclude = [...excludeFileIds];

  for (let round = 0; round < config.brandingDiscoveryRounds; round++) {
    const [hits] = await searchProbes(milvus, [{ time: 0, vector: item.vector }], null, exclude);
    if (hits.length === 0) break;
    const before = exclude.length;
    for (const hit of hits) {
      // a branding bumper lives at the head of the file
      if (hit.time <= headWindow) found.add(hit.file_id);
    }
    exclude.push(...new Set(hits.map((e) => e.file_id)));
    // nothing new to exclude, or the hit limit was not the binding constraint
    if (exclude.length === before || hits.length < config.searchLimit) break;
  }

  return [...found];
};
