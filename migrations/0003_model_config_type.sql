-- Adds config.model_type as a family-resolution source.
--
-- The Hub returns config.model_type in the same listing request we already
-- make — it just has to be asked for. Measured on 400 of the newest models it
-- resolves a further 11.5% (22% -> 34% coverage), and it is the canonical
-- architecture field rather than a tag derived from it.
--
-- It needs its own provenance value. Recording it as 'name_pattern' would
-- present a declared architecture as a guess from the title, and
-- 'gguf_architecture' would claim we parsed GGUF metadata we never read. The
-- point of resolution_source is that a confident source is never mistaken for
-- a weak one.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt. That also
-- lets the new column land in the same pass rather than costing two rewrites.
--
-- COST: rewrites every hf_models row (~75,000 at time of writing), most of a
-- day's 100,000-row free-plan budget. Run it on a day with no pipeline run, or
-- after moving to Workers Paid.
--
-- TO ROLL BACK, before dropping hf_models_pre_0003:
--     DROP TABLE hf_models;
--     ALTER TABLE hf_models_pre_0003 RENAME TO hf_models;
-- then recreate the three indexes below.
--
-- No PRAGMA foreign_keys guard: the only foreign key in the schema is
-- hf_classifications.space_id -> hf_spaces, so dropping and renaming
-- hf_models cannot trip one. D1 accepts only a subset of PRAGMAs, and an
-- unnecessary one is just a way for the whole paste to fail.

CREATE TABLE hf_models_new (
  repo_id             TEXT PRIMARY KEY,
  author              TEXT,
  created_at          TEXT NOT NULL,
  last_modified       TEXT,
  downloads           INTEGER NOT NULL DEFAULT 0,
  downloads_all_time  INTEGER,
  likes               INTEGER NOT NULL DEFAULT 0,
  pipeline_tag        TEXT,
  library_name        TEXT,
  tags                TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  base_model          TEXT,
  card_base_model     TEXT,
  -- config.model_type, e.g. "llama", "qwen3_5_moe", "gemma3".
  model_type          TEXT,
  family              TEXT,
  derivative_type     TEXT CHECK (
                        derivative_type IS NULL OR derivative_type IN
                        ('base', 'finetune', 'quantization', 'adapter', 'merge', 'other')
                      ),
  resolution_source   TEXT CHECK (
                        resolution_source IS NULL OR resolution_source IN
                        ('base_model_tag', 'card_data', 'config_model_type',
                         'gguf_architecture', 'name_pattern')
                      ),
  first_seen_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

INSERT INTO hf_models_new
  SELECT repo_id, author, created_at, last_modified, downloads, downloads_all_time,
         likes, pipeline_tag, library_name, tags, base_model, card_base_model,
         NULL, family, derivative_type, resolution_source, first_seen_at, updated_at
  FROM hf_models;

-- Renamed, not dropped. D1's Time Travel point-in-time restore is a paid
-- feature, so on the Free plan a DROP here has no recovery point: if the copy
-- above silently lost rows — a CHECK the old data violates, a write budget
-- exhausted mid-statement — there would be nothing to go back to. The rename
-- is metadata-only and writes no rows, so the rollback costs nothing.
--
-- After verifying (SELECT COUNT(*) should match on both), reclaim the space:
--     DROP TABLE hf_models_pre_0003;
ALTER TABLE hf_models RENAME TO hf_models_pre_0003;

-- Index names are global in SQLite, and RENAME carries the old table's indexes
-- with it rather than dropping them — so recreating them below collides with
-- "index idx_models_created already exists". A DROP TABLE took them out
-- implicitly; a rename does not. The backup keeps its data, just not its
-- indexes, which it does not need.
DROP INDEX idx_models_created;
DROP INDEX idx_models_family;
DROP INDEX idx_models_base;

ALTER TABLE hf_models_new RENAME TO hf_models;

CREATE INDEX idx_models_created ON hf_models (created_at);
CREATE INDEX idx_models_family ON hf_models (family, created_at);
CREATE INDEX idx_models_base ON hf_models (base_model);
