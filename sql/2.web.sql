CREATE MATERIALIZED VIEW IF NOT EXISTS index_content AS
SELECT
  id,
  COALESCE(
    NULLIF(json -> 'title' ->> 'english', ''),
    NULLIF(json -> 'title' ->> 'romaji', ''),
    NULLIF(json -> 'title' ->> 'native', '')
  ) AS name
FROM
  anilist
WHERE
  (json ->> 'isAdult')::boolean = FALSE
ORDER BY
  name,
  id;

ALTER TABLE IF EXISTS files
ADD COLUMN episode smallint;
