export interface HashFrame {
  time: number;
  vector: number[];
}

// a frame is redundant only if an identical frame is this recent
export const DEDUPE_WINDOW = 2;
// how many kept frames to scan back through
export const DEDUPE_LOOKBACK = 50;

/**
 * The frames that actually end up in Milvus. Anything computing what a file
 * *should* have indexed has to go through here, otherwise it is comparing
 * against color_layout, which holds every decoded frame and is several times
 * larger.
 */
export const dedupeHashList = <T extends HashFrame>(hashList: T[]): T[] => {
  const sorted = hashList.sort((a, b) => a.time - b.time);
  const dedupedHashList: T[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const currentFrame = sorted[i];
    let isDuplicate = false;

    // search last DEDUPE_LOOKBACK deduplicated frames
    const startIndex = Math.max(0, dedupedHashList.length - DEDUPE_LOOKBACK);
    for (let j = dedupedHashList.length - 1; j >= startIndex; j--) {
      const frame = dedupedHashList[j];
      // which is within DEDUPE_WINDOW sec in time
      if (currentFrame.time - frame.time < DEDUPE_WINDOW) {
        // skip frames with exact hash by comparing each value in vector
        let exactMatch = true;
        for (let k = 0; k < frame.vector.length; k++) {
          if (frame.vector[k] !== currentFrame.vector[k]) {
            exactMatch = false;
            break;
          }
        }
        if (exactMatch) {
          isDuplicate = true;
          break;
        }
      }
    }
    if (!isDuplicate) dedupedHashList.push(currentFrame);
  }

  return dedupedHashList;
};
