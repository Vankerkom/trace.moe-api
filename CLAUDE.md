# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

trace.moe-api is the backend HTTP API and background indexing service for trace.moe (anime scene search engine). It serves image/video-based scene search requests and continuously indexes a local video library into PostgreSQL (metadata) and Milvus (vector search).

- **Runtime**: Node.js >= 24, running `.ts` files directly (no `tsc`/`ts-node`/`--strip-types` build step — this project never compiles).
- **Framework**: Express 5
- **Databases**: PostgreSQL (via `postgres` npm package), Milvus vector DB (via `@zilliz/milvus2-sdk-node`)
- **External binaries required on PATH**: `ffmpeg`, `ffprobe` (checked at startup by `dependency-check.ts`)
- **Media/image processing**: `sharp`, `aniep` (episode number parsing), `trace.moe-id` (`ColorLayout` MPEG-7 descriptor encode/decode)

## Commands

```bash
npm run start    # node --max-old-space-size=512 server.ts — starts the API server + indexing worker
node server.ts   # equivalent direct invocation
npm run lint      # prettier --check "**/*.*"  (this IS the test script too)
npm run format    # prettier --write "**/*.*"
node <file>.ts    # run any script directly, e.g. script/check-similarity.ts, script/bulk-load-milvus.ts
```

There is no separate test suite — `npm test` just runs the prettier check. Formatting (Prettier, with `prettier-plugin-sql` and `prettier-plugin-embed`) and `oxfmt` are the only lint gates; always run `npm run lint` before finishing a change.

Local infra (PostgreSQL + Milvus) is brought up via `docker compose up -d` (see `compose.yml` / `milvus.yaml`). Config comes from `.env` (copy from `.env.example`); `env.ts` is imported for its side effect of validating required vars (`VIDEO_PATH`, `TRACE_API_SALT`, `MILVUS_ADDR`, `MILVUS_TOKEN`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`) and exits the process if any are missing.

When Postgres runs in Docker, query it via:

```bash
docker exec -i tracemoe-api-postgres-1 psql -U postgres -d postgres -c "..."
```

## Architecture

### Startup (`server.ts`)

On boot, `server.ts` (in order): loads/validates env, checks ffmpeg/ffprobe are installed, cleans up stale `/tmp/trace.moe-*` dirs, ensures `VIDEO_PATH` exists, auto-creates the Postgres schema from `sql/1.init.sql` if tables are missing, connects to Milvus and auto-creates the `frame_color_layout` collection (33-dim Float16 vectors, IVF_SQ8 index) if absent, then attaches shared state to `app.locals` (`milvus` client, `sqids` encoder, `mediaQueue`, `searchQueue`, `searchConcurrent`, `taskManager`) before listening. It also periodically re-scans `VIDEO_PATH` (`SCAN_INTERVAL`, default 60s) via `TaskManager`, and handles graceful shutdown on SIGINT/SIGTERM (drains HTTP, closes Milvus + Postgres).

### Request layer (`src/app.ts` + `src/*.ts`)

Express app wiring: CORS, rate limiting (100 req/min global; 60 req/hr for `/user/*`), request logging middleware, body parsing for octet-stream/urlencoded/json/multipart. Key routes:

- `POST /search` (`src/search.ts`) — the core scene search endpoint (see below)
- `GET /image/:id`, `GET /video/:id` (`src/image.ts`, `src/video.ts`) — signed preview URLs (see below)
- `GET /me`, `/anilist`, `/status`, `/stats`, `/tasks` — quota/status/metrics endpoints
- `/user/*` (`src/user/`) — signup/login/API key/password management
- `/webhook/*` (`src/webhook/`) — GitHub/Patreon webhook receivers

### Video indexing pipeline (`src/worker/task-manager.ts` + `src/worker/*.ts`)

`TaskManager` drives a multi-stage pipeline over rows in the `files` Postgres table, gated by `MAX_WORKER` concurrent `worker_threads` per stage. Each stage's "run" method queries for files missing a given column, spawns a `Worker` per file (capped at `MAX_WORKER`), and on each worker's exit re-triggers itself and downstream stages:

1. **scan** — walks `VIDEO_PATH` (files must live under a numeric-named directory = the AniList ID) for `.mp4`/`.mkv`/`.webm`, inserts new paths into `files`, and parses episode ranges via `aniep` + `parse-episode.ts`.
2. **anilist** (`worker/anilist.ts`) — fetches AniList metadata for referenced anilist_ids not yet in the `anilist` table.
3. **crc32** (`worker/crc32.ts`), **media-info** (`worker/media-info.ts`), **scene-changes** (`worker/scene-changes.ts`), **color-layout** (`worker/color-layout.ts`) — run independently/in parallel per file, populate the corresponding `files` columns.
4. **milvus-load** (`worker/milvus-load.ts`) — once media_info, scene_changes, color_layout are all populated and the file's anilist_id exists in `anilist`, loads the file's per-scene color-layout vectors into the Milvus `frame_color_layout` collection and marks `files.loaded`. It deletes any existing vectors for the file first, so re-loading is idempotent.
5. **branding** (`worker/branding.ts`) and **dedup** (`worker/dedup.ts`) — segment deduplication, see below. Branding always runs first, so the opening/ending pass can mask out the ranges it claimed. Both are skipped entirely when `DEDUP_ENABLED=0`.

Task status is broadcast over SSE (`TaskManager.publish`/`subscribe`) to the `/tasks` endpoint (`src/tasks.ts` + `src/tasks.html`).

The Color Layout Descriptor (MPEG-7-style, 8×8 grid + 2D-DCT) is deliberately implemented in pure JS rather than native code — see README.md's "Notes on Color Layout Computation" for the rationale (video decode via ffmpeg subprocess dominates cost; JS keeps it portable/browser-compatible). Hardware video decoding is intentionally not used either (see README's decode benchmarks) — CPU software decode outperforms GPU decode for this workload.

### Segment deduplication (`src/lib/segment-*.ts`, `src/lib/branding-pool.ts`)

Openings and endings are near-identical across every episode of a series, so indexing them per episode wastes most of the Milvus index. The **dedup** stage groups a series by `anilist_id`, samples probe frames from a reference episode's `files.color_layout` into the head/tail window, searches them against Milvus scoped to that series, and histograms `targetTime - referenceTime`: a repeated segment appears as a run of probes sharing one time offset per episode (a diagonal in the match matrix), which tolerates dark frames and per-episode edits.

Each accepted segment is cut to `segments/<anilist_id>/<type>-<segmentFileId>-<referenceFileId>.mp4` (downscaled to 720p if the source is taller) and inserted as an ordinary `files` row carrying a `segment_type` marker, so the existing media-info → scene-changes → color-layout → milvus-load stages index it unchanged. `segment_matches` records every episode it was extracted from and where. Once the synthetic file is `loaded`, those ranges are **deleted** from every source episode — that is the point of the feature. `files.color_layout` is never touched, so any prune is reversible via `POST /debug/segments/:id/revert`.

Details that are easy to get wrong, all learned from real failures:

- Detection peels: after accepting a segment it removes the episodes it explains and looks again, because a series usually changes its opening/ending at a cour boundary. It also masks the _time ranges_ already claimed — a first episode that plays its opening at the end would otherwise let the ending pass rediscover the opening.
- A round that finds nothing advances the reference cursor instead of stopping; the first episodes of a series are frequently atypical.
- `extractSegment` reserves the row id from `files_id_seq` and only inserts the row after ffmpeg finishes, otherwise the indexing stages pick up a path that is still being written.
- A candidate is rejected when it is footage the series already has, not when its episodes are already covered. Detection re-runs as a series grows and is handed a different subset of episodes each time, so counting new episodes cut the same opening once per growth spurt. `findDuplicateSegment` compares a candidate against every existing segment of the series, by range overlap on a shared episode and by aligning the frames themselves, and a full run is deferred entirely while a segment is still being indexed (its ranges are not pruned out of Milvus yet, so detection would rediscover its own footage).
- `revertSegment` rebuilds whole files, which restores ranges other segments had pruned, so it re-queues those matches.

`src/search.ts` expands a hit on a segment file into one result per source episode, with timestamps remapped into the real episode, before the top-10 slice — so an opening search returns every episode it appears in and the preview URLs stream from the original files. Branding bumpers come from `BRANDING_PATH` (default `$VIDEO_PATH/branding`) as a pair per bumper: `<name>.png` is hashed in memory and used as a single Milvus query to discover which episodes contain it at all (paginated past `DEDUP_SEARCH_LIMIT` by re-querying with what it already found excluded), and `<name>.mp4`/`.mkv` is registered in place as an ordinary `files` row with `segment_type='branding'` and a NULL `anilist_id` — nothing is cut with ffmpeg. Once the clip is indexed, `matchSegmentToFiles` aligns its own frames against the discovered episodes to fix the exact per-episode range. `revertSegment` will not delete a file outside `segments/`, so reverting a bumper leaves the user's clip on disk.

`DEDUP_MILVUS_READONLY=1` detects and records without writing to Milvus. `/debug/*` routes (mounted only when `DEBUG_ENDPOINTS` is set, unauthenticated) drive dry runs, applies, prunes and reverts.

### Search flow (`src/search.ts`)

`POST /search` accepts either an uploaded image/video frame, a remote `url` to fetch, or a precomputed `vector` (single, or an array of up to 10 for batch search — legacy 33-byte base64 and the newer `trace.moe-id` `ColorLayout` encoding are both accepted). It applies per-IP or per-API-key quota/concurrency/priority limits (tiers stored in Postgres `tiers`/`users_view`), optionally crops black borders and extracts a Color Layout vector via `prepare-search-image.ts` + `ColorLayout.extract`, queries Milvus for nearest frame vectors (optionally scoped to one `anilistID`), then merges adjacent-in-time hits per file into scene ranges and returns the top 10, each with a signed, time-expiring `preview` `video`/`image` URL (HMAC-derived via `TRACE_API_SALT`, encoded with `sqids`). All requests are logged to Postgres `logs` for quota accounting regardless of outcome.

### Signed preview URLs (`src/image.ts`, `src/video.ts`)

IDs passed to `/image/:id` and `/video/:id` are `sqids`-encoded `[file_id, time, expire, hash]` tuples generated by `search.ts`; the hash is an HMAC-style check against `TRACE_API_SALT` and an hour-aligned expiry window (for CDN cache friendliness). These handlers decode/validate the ID, then stream a cropped frame or a short clip from the source video via ffmpeg.

### Scripts (`script/`)

One-off/maintenance scripts run directly with `node script/<name>.ts`: `bulk-load-milvus.ts`, `compact-milvus.ts`, `cleanup.ts` (temp file cleanup), `check-similarity.ts`, `check-subtitles.ts`, `check-user.ts`, `dump-files.ts`, `mmap.ts`, `anilist.ts`. These are not wired into npm scripts — read the script header/usage before running.

### Database

`sql.ts` exports the shared `postgres` client singleton (imported as `../../sql.ts` / `../sql.ts` from nested dirs). Schema lives in `sql/1.init.sql` (initial) and `sql/2.episode_range.sql` (migration), auto-applied by `server.ts` only when the `public` schema is empty — there is no migration runner, so schema changes need a new numbered `sql/*.sql` file plus manual application to existing databases.
