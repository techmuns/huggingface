-- Adds 'architecture_tag' as a resolution source.
--
-- ~13% of new models (measured on 400 of the Hub's newest) declare no
-- base_model but do carry a model_type tag — "llama", "qwen3_5_moe", "gemma".
-- Reading those is the cheapest family coverage available and entirely
-- deterministic, but it needs its own provenance value: recording it as
-- 'name_pattern' would present a declared architecture as a guess from the
-- title, and 'gguf_architecture' would claim we parsed GGUF metadata we never
-- read. The whole purpose of resolution_source is that a confident source is
-- never confused with a weak one.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- COST: this rewrites every row in hf_models (~75,000 at time of writing),
-- which is most of a day's 100,000-row free-plan write budget. Run it on a day
-- with no pipeline run, or after moving to Workers Paid.

PRAGMA foreign_keys = OFF;

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
  family              TEXT,
  derivative_type     TEXT CHECK (
                        derivative_type IS NULL OR derivative_type IN
                        ('base', 'finetune', 'quantization', 'adapter', 'merge', 'other')
                      ),
  resolution_source   TEXT CHECK (
                        resolution_source IS NULL OR resolution_source IN
                        ('base_model_tag', 'card_data', 'architecture_tag',
                         'gguf_architecture', 'name_pattern')
                      ),
  first_seen_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

INSERT INTO hf_models_new
  SELECT repo_id, author, created_at, last_modified, downloads, downloads_all_time,
         likes, pipeline_tag, library_name, tags, base_model, card_base_model,
         family, derivative_type, resolution_source, first_seen_at, updated_at
  FROM hf_models;

DROP TABLE hf_models;
ALTER TABLE hf_models_new RENAME TO hf_models;

CREATE INDEX idx_models_created ON hf_models (created_at);
CREATE INDEX idx_models_family ON hf_models (family, created_at);
CREATE INDEX idx_models_base ON hf_models (base_model);

PRAGMA foreign_keys = ON;
