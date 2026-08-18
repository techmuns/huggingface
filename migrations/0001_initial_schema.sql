-- Phase 2 — the data model.
--
-- The spine of this schema is the one architectural rule: raw scraped data is
-- immutable, and every classification is a separate, rebuildable layer. The
-- taxonomy will change, and when it does we must be able to re-derive all
-- history from what was already fetched, without re-scraping. That is why
-- hf_raw_records is append-only and why hf_classifications is keyed by
-- taxonomy version rather than overwritten in place.
--
-- D1 is SQLite, so Postgres idioms do not transfer:
--   * arrays are TEXT holding a JSON array, unnested with json_each()
--   * timestamps are ISO-8601 TEXT, so lexical sort equals chronological sort
--   * booleans are INTEGER 0/1
--   * tables are STRICT, which SQLite otherwise does not enforce at all
--
-- STRICT permits only INT/INTEGER/REAL/TEXT/BLOB/ANY, so there is deliberately
-- no DATETIME, BOOLEAN or VARCHAR below.

-- ---------------------------------------------------------------------------
-- 1. hf_raw_records — every API payload, verbatim. Append-only, never updated.
-- ---------------------------------------------------------------------------
CREATE TABLE hf_raw_records (
  id           INTEGER PRIMARY KEY,
  -- Groups every record fetched by one pipeline run, so a run can be replayed
  -- or discarded as a unit.
  run_id       TEXT NOT NULL,
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('model', 'space')),
  entity_id    TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  -- The unparsed listing entry. Validated on write because a payload that
  -- turns out to be unparseable is only discovered at replay time otherwise,
  -- which is exactly when re-fetching is no longer possible.
  payload      TEXT NOT NULL CHECK (json_valid(payload))
) STRICT;

-- Replay reads by entity; `fetched_at` last so the newest payload for an
-- entity is a range scan rather than a sort.
CREATE INDEX idx_raw_entity ON hf_raw_records (entity_kind, entity_id, fetched_at);
CREATE INDEX idx_raw_run ON hf_raw_records (run_id);

-- ---------------------------------------------------------------------------
-- 2. hf_models — typed model fields, upserted from raw.
-- ---------------------------------------------------------------------------
CREATE TABLE hf_models (
  repo_id             TEXT PRIMARY KEY,           -- "author/name"
  author              TEXT,
  created_at          TEXT NOT NULL,
  last_modified       TEXT,

  -- Downloads are a rolling 30-day figure: a rate, not a total. Kept in a
  -- separate column from the cumulative counter so the two can never be
  -- averaged together into a meaningless trend line.
  downloads           INTEGER NOT NULL DEFAULT 0,
  downloads_all_time  INTEGER,
  likes               INTEGER NOT NULL DEFAULT 0, -- cumulative

  pipeline_tag        TEXT,
  library_name        TEXT,
  tags                TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),

  -- The declared parent repo, after the base_model:<relation>:<target> tag or
  -- cardData is resolved. NULL means undeclared, which is the common case:
  -- only ~17% of new models declare lineage anywhere.
  base_model          TEXT,

  -- Derived in Phase 4 by deterministic rules over the columns above. Nullable
  -- because they are rebuilt, not ingested; a NULL family means unresolved,
  -- which is a reportable outcome rather than an error.
  family              TEXT,
  derivative_type     TEXT CHECK (
                        derivative_type IS NULL OR derivative_type IN
                        ('base', 'finetune', 'quantization', 'adapter', 'merge', 'other')
                      ),
  -- Which rung of the fallback chain produced `family`, so a slug-matched
  -- guess is never read as equal to a declared base_model.
  resolution_source   TEXT CHECK (
                        resolution_source IS NULL OR resolution_source IN
                        ('base_model_tag', 'card_data', 'gguf_architecture', 'name_pattern')
                      ),

  -- created_at is authoritative for "new", but the two diverge on backfills,
  -- renames and private->public flips, so first_seen_at is recorded to make
  -- that discrepancy detectable rather than invisible.
  first_seen_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_models_created ON hf_models (created_at);
CREATE INDEX idx_models_family ON hf_models (family, created_at);
CREATE INDEX idx_models_base ON hf_models (base_model);

-- ---------------------------------------------------------------------------
-- 3. hf_spaces — typed Space fields, upserted from raw.
-- ---------------------------------------------------------------------------
CREATE TABLE hf_spaces (
  space_id           TEXT PRIMARY KEY,
  author             TEXT,
  created_at         TEXT NOT NULL,
  last_modified      TEXT,
  likes              INTEGER NOT NULL DEFAULT 0,

  title              TEXT,
  short_description  TEXT,
  -- ~53% of new Spaces are sdk 'static'. Stored rather than filtered so the
  -- dashboard can report with and without them instead of taking a silent
  -- position on whether a browser-only demo is developer activity.
  sdk                TEXT,
  tags               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  linked_models      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(linked_models)),
  linked_datasets    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(linked_datasets)),

  -- Roughly half of new Spaces arrive with no description and no linked
  -- model. That subset is the only one worth spending a README fetch on, so
  -- the tier is stored rather than recomputed at every stage.
  signal_tier        TEXT CHECK (signal_tier IS NULL OR signal_tier IN ('rich', 'blind')),

  -- Phase 5. readme_status records why a fetch produced no text, so the
  -- enrichment funnel stays visible: ~58% of blind-subset READMEs are the
  -- ~195-byte auto-generated stub and must be counted, not silently dropped.
  readme_text        TEXT,
  readme_hash        TEXT,
  readme_fetched_at  TEXT,
  readme_status      TEXT CHECK (
                       readme_status IS NULL OR readme_status IN
                       ('ok', 'stub', 'missing', 'error')
                     ),

  -- Phase 5 dedup. 12.8% of new Spaces share a normalized title within 24h,
  -- and one viral template produced 2% of a day's Spaces on its own. Metrics
  -- count clusters, so they filter on is_cluster_primary.
  dedup_cluster_id   TEXT,
  is_cluster_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_cluster_primary IN (0, 1)),

  first_seen_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;

CREATE INDEX idx_spaces_created ON hf_spaces (created_at);
CREATE INDEX idx_spaces_cluster ON hf_spaces (dedup_cluster_id);
-- Drives the Phase 5 work queue: which blind Spaces still need a README.
CREATE INDEX idx_spaces_enrich ON hf_spaces (signal_tier, readme_status);

-- ---------------------------------------------------------------------------
-- 4. hf_classifications — the rebuildable layer. One row per Space per
--    taxonomy version, so two versions coexist and history restates.
-- ---------------------------------------------------------------------------
CREATE TABLE hf_classifications (
  id                     INTEGER PRIMARY KEY,
  space_id               TEXT NOT NULL REFERENCES hf_spaces (space_id) ON DELETE CASCADE,
  taxonomy_version       TEXT NOT NULL,

  -- Exactly one primary use case per Space. This single-valued constraint is
  -- what lets "share of new Spaces by use case" sum to 100%.
  primary_use_case       TEXT NOT NULL,
  use_case_confidence    REAL,

  -- Multi-label. Percentages over these are penetration rates and do NOT sum
  -- to 100% — conflating the two silently corrupts every chart downstream.
  verticals              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(verticals)),
  verticals_confidence   REAL,
  model_families         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(model_families)),
  families_confidence    REAL,
  technologies           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(technologies)),
  technologies_confidence REAL,

  low_confidence         INTEGER NOT NULL DEFAULT 0 CHECK (low_confidence IN (0, 1)),
  reviewed               INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),

  -- Provenance. 'rule' rows are free and deterministic; 'model' rows carry the
  -- model id and prompt version that produced them, so a prompt change is
  -- attributable after the fact.
  source_kind            TEXT NOT NULL CHECK (source_kind IN ('rule', 'model')),
  source_ref             TEXT NOT NULL,
  prompt_version         TEXT,
  rationale              TEXT,

  -- Cache key together with space_id and prompt_version: unchanged content
  -- plus unchanged prompt means the row is reused rather than re-inferred.
  content_hash           TEXT,
  classified_at          TEXT NOT NULL,

  UNIQUE (space_id, taxonomy_version)
) STRICT;

CREATE INDEX idx_class_taxonomy_usecase ON hf_classifications (taxonomy_version, primary_use_case);
-- The Phase 9 review queue.
CREATE INDEX idx_class_review ON hf_classifications (low_confidence, reviewed);

-- ---------------------------------------------------------------------------
-- 5. hf_weekly_metrics — precomputed aggregates, one row per week x cut x
--    dimension. Precomputed because D1 is single-threaded and these are
--    multi-dimensional group-bys that must not run per page load.
-- ---------------------------------------------------------------------------
CREATE TABLE hf_weekly_metrics (
  id               INTEGER PRIMARY KEY,
  week_start       TEXT NOT NULL,               -- Monday, ISO date
  metric_cut       TEXT NOT NULL,               -- e.g. 'spaces_by_use_case'
  dimension        TEXT NOT NULL,               -- the bucket label

  -- Second axis of a cross-tab, e.g. use case x model family. Empty string
  -- rather than NULL, deliberately: SQLite treats NULLs as distinct in a
  -- UNIQUE index, so a nullable column here would let the same metric be
  -- inserted repeatedly instead of upserting, and every re-run would
  -- double-count.
  sub_dimension    TEXT NOT NULL DEFAULT '',

  value            REAL NOT NULL,

  -- Every metric row carries its own denominator and coverage. Not optional:
  -- it is the only thing that stops a count over the ~50% of Spaces that were
  -- classifiable at all from being read as an absolute.
  denominator      INTEGER NOT NULL,
  coverage         REAL,

  delta_1w         REAL,
  delta_4w         REAL,
  delta_12w        REAL,

  -- Set when the denominator is too small to report a percentage change
  -- honestly. Suppressed rows are still stored, so the dashboard can say
  -- "too few to report" rather than silently omitting the row.
  suppressed       INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),

  taxonomy_version TEXT NOT NULL,
  computed_at      TEXT NOT NULL,

  UNIQUE (week_start, metric_cut, dimension, sub_dimension, taxonomy_version)
) STRICT;

CREATE INDEX idx_metrics_cut ON hf_weekly_metrics (week_start, metric_cut);
CREATE INDEX idx_metrics_series ON hf_weekly_metrics (metric_cut, dimension, week_start);
