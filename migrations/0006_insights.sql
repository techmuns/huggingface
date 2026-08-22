-- Where the written summaries live.
--
-- They were already being generated every week and then thrown away. Phase 8
-- handed the narrative to buildSnapshot, which committed it to GitHub, and
-- /api/narrative read it back out of the repository — so the dashboard's
-- summary card depended on the Worker's GITHUB_TOKEN holding `contents: write`
-- at the moment the run finished. It does not, and has not for some time, so
-- `/api/narrative?week=` answers `not_found` for every week on record while
-- the card hides itself. A permanently broken feature looked exactly like one
-- that was never built.
--
-- Text the pipeline paid a model to write belongs in the database beside the
-- numbers it describes. The GitHub archive stays what it always was — an
-- archive — rather than being the primary store for a read path.
--
-- Keyed by (kind, period_key) rather than by week_start, because a monthly
-- insight is not a property of any one week. taxonomy_version is in the key
-- for the same reason it is everywhere else: a taxonomy change restates
-- history, and two versions have to be able to coexist rather than one
-- silently overwriting the other's prose.
--
-- COST: one empty table. Nothing is rewritten, nothing is dropped.

CREATE TABLE IF NOT EXISTS hf_insights (
  id                INTEGER PRIMARY KEY,

  -- 'week' | 'month'. Not a CHECK over a longer list: quarters would need
  -- their own eligibility rules and there is no reader for them yet.
  kind              TEXT NOT NULL CHECK (kind IN ('week', 'month')),
  -- '2026-08-10' for a week (its Monday), '2026-08' for a month.
  period_key        TEXT NOT NULL,
  -- The Monday this was generated from, so a weekly insight can still be
  -- joined to hf_weekly_metrics without parsing period_key.
  week_start        TEXT,

  taxonomy_version  TEXT NOT NULL,

  -- The prose, with every figure already substituted in. The model never
  -- writes a digit; see src/lib/insights.ts.
  narrative         TEXT NOT NULL,
  -- The fact pack it was given, verbatim, as a JSON array. This is what makes
  -- a published sentence checkable after the fact: every number in the prose
  -- came from exactly one of these, and which one is recoverable.
  facts             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(facts)),

  -- Why a period has no insight. Stored rather than left absent, so "the model
  -- would not ground its numbers" is distinguishable from "this never ran".
  status            TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok', 'ungrounded', 'insufficient', 'error')),
  detail            TEXT,

  model_id          TEXT,
  prompt_version    TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  generated_at      TEXT NOT NULL,

  UNIQUE (kind, period_key, taxonomy_version)
) STRICT;

CREATE INDEX idx_insights_recent ON hf_insights (kind, period_key DESC);
