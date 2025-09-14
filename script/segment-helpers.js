export function filterByScore(searchResults, maxScore = 1.0) {
  return searchResults
    .map((result, index) => (result <= maxScore ? index : -1))
    .filter((index) => index !== -1);
}

export function groupSegments(timeCodes, maxGap = 10.0) {
  const groupedSegments = [];

  if (timeCodes.length > 0) {
    let grouped = [timeCodes[0]];

    for (let i = 1; i < timeCodes.length; i++) {
      if (timeCodes[i] - timeCodes[i - 1] > maxGap) {
        groupedSegments.push(grouped);
        grouped = [timeCodes[i]];
      } else {
        grouped.push(timeCodes[i]);
      }
    }

    groupedSegments.push(grouped);
  }

  return groupedSegments;
}

export function filterByMinSegmentDuration(groupedSegments, minimumDuration = 10.0) {
  return groupedSegments.filter(
    (segment) => segment[segment.length - 1] - segment[0] >= minimumDuration,
  );
}

export function printSegments(segments, segmentName = "Segment") {
  segments.forEach((segment, index) => printSegment(segment, index, segmentName));
}

export function printSegment(segment, index, segmentName = "Segment") {
  const start = segment[0];
  const end = segment[segment.length - 1];
  const duration = end - start;
  console.log(`${segmentName}: ${index}, start: ${start}, end: ${end} duration: ${duration}`);
}

export function findSegments(
  hashes,
  scoresPerFrame,
  maxDistanceScore,
  maxGapBetweenFrames,
  minimumSegmentDuration,
) {
  const duplicateSegments = filterByScore(scoresPerFrame, maxDistanceScore);
  const duplicatedTimeCodes = duplicateSegments.map((index) => hashes[index].time);
  const groupedSegments = groupSegments(duplicatedTimeCodes, maxGapBetweenFrames);
  const groupedSegmentsFiltered = filterByMinSegmentDuration(
    groupedSegments,
    minimumSegmentDuration,
  );

  console.log("duplicatedTimeCodes", duplicatedTimeCodes.length);
  console.log("groupedSegments", groupedSegments.length);
  console.log("groupedSegmentsFiltered", groupedSegmentsFiltered.length);

  return groupedSegmentsFiltered;
}
