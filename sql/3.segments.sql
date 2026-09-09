ALTER TABLE files
ADD COLUMN IF NOT EXISTS segment_type text;

ALTER TABLE files
ADD COLUMN IF NOT EXISTS segment_label text;

ALTER TABLE files
ADD COLUMN IF NOT EXISTS segment_reference_id integer;

ALTER TABLE files
DROP CONSTRAINT IF EXISTS files_segment_type_check;

ALTER TABLE files
ADD CONSTRAINT files_segment_type_check CHECK (
  segment_type IS NULL
  OR segment_type IN ('opening', 'ending', 'branding')
);

CREATE INDEX IF NOT EXISTS files_segment_idx ON files (anilist_id)
WHERE
  segment_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS segment_matches (
  id serial PRIMARY KEY,
  segment_file_id integer NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  file_id integer NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  start_time real NOT NULL,
  end_time real NOT NULL,
  score real,
  milvus_deleted boolean NOT NULL DEFAULT FALSE,
  created timestamp NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS segment_matches_segment_file_idx ON segment_matches (segment_file_id, file_id);

CREATE INDEX IF NOT EXISTS segment_matches_file_id_idx ON segment_matches (file_id);

CREATE INDEX IF NOT EXISTS segment_matches_prune_pending_idx ON segment_matches (segment_file_id)
WHERE
  milvus_deleted = FALSE;

CREATE TABLE IF NOT EXISTS dedup_runs (
  anilist_id integer PRIMARY KEY,
  updated timestamp NOT NULL DEFAULT NOW(),
  loaded_file_count integer NOT NULL,
  segments_found integer NOT NULL DEFAULT 0,
  detect_ms integer,
  extract_ms integer,
  log jsonb
);

CREATE INDEX IF NOT EXISTS dedup_runs_updated_idx ON dedup_runs (updated);
