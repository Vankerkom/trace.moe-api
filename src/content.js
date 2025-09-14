import sql from "../sql.js";

export async function contentIndex(req, res) {
  const items = await sql`
    SELECT
      id,
      name
    FROM
      index_content
  `;

  res.json(items);
}

export async function contentDetails(req, res) {
  const seriesId = req.params.id;

  const [series] = await sql`
    SELECT
      id,
      json -> 'title' ->> 'romaji' as "name",
      json -> 'title' ->> 'english' as "nameEnglish",
      json -> 'title' ->> 'native' as "nameNative",
      json -> 'format' as "type",
      null as "description",
      json -> 'coverImage' ->> 'large' as "posterPath",
      json -> 'id' as "anilistId",
      json -> 'malId' as "anilistId",
      null as "youtubeId",
      null as "tvdbId",
      null as "tmdbId",
      null as "anidbId",
      (json ->> 'isAdult')::boolean as "nsfw",
      json -> 'episodes' as "totalEpisodes",
      json -> 'status' as "status",
      null as "startDate",
      null as "endDate"
    FROM
      anilist
    WHERE
      id = ${seriesId}
      AND (json ->> 'isAdult')::boolean IS FALSE
    LIMIT
      1
  `;

  if (!series) {
    res.status(404).json({});
    return;
  }

  let availableEpisodes = await sql`
    SELECT DISTINCT
      episode
    FROM
      files
    WHERE
      anilist_id = ${series.id}
      AND episode IS NOT NULL
    ORDER BY
      episode
  `;
  availableEpisodes = availableEpisodes.map((x) => x.episode);

  const largestEpisode = Math.max(series?.totalEpisodes ?? 0, availableEpisodes.at(-1) ?? 0);
  const availableSet = new Set(availableEpisodes);

  const episodes = Array.from({ length: largestEpisode }, (_, i) => {
    const number = i + 1;
    return {
      number,
      name: `Episode ${number}`,
      airDate: null,
      available: availableSet.has(number),
    };
  });

  res.status(200).json({
    ...series,
    episodes,
  });
}
