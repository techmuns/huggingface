-- The model-family resolver was reading 22.5 million rows a run to return
-- about four hundred.
--
-- Measured on the live database, 24 hours to 2026-08-25, from D1's own query
-- insights. Four queries, all of them the resolver walking the unresolved set:
--
--     rows read   returned   query
--     10,330,000       177   SELECT repo_id FROM hf_models WHERE family IS NULL ...
--      5,260,000       122   SELECT repo_id, model_type, tags, ... WHERE family IS NULL ...
--      4,920,000       119   SELECT repo_id, tags FROM hf_models WHERE family IS NULL ...
--      2,020,000         -   SELECT m.repo_id, parent.family FROM hf_models m JOIN ...
--
-- One run read 19.5 million rows against a free-plan ceiling of 5 million a
-- DAY. Not four runs — one. Reads, not writes, are what this pipeline cannot
-- afford: writes came in at 77,570 against a 100,000 ceiling.
--
-- WHY IT SCANNED. Every cursored rung asks the same shape:
--
--     WHERE family IS NULL AND repo_id > ?1 ORDER BY repo_id LIMIT ?2
--
-- and the index it had to work with was (family, created_at). SQLite can seek
-- to the family IS NULL section with that, but the rows underneath are ordered
-- by created_at, which the query neither filters nor orders on. So it read
-- every unresolved row — roughly 88,000 of them — and sorted, on every
-- sub-chunk, 117 times a run.
--
-- SWAPPED, NOT ADDED, and that distinction is the point. An index is not free
-- on D1: it bills an extra written row whenever a write touches its column, so
-- adding a fourth index to hf_models would cost ~24,000 writes a run and push
-- 77,570 to over the 100,000 ceiling — trading a read problem for a write one.
-- (family, created_at) can be given up because nothing needs it: every
-- `family = ` in src/ is a SET inside an UPDATE, never a filter, and the
-- aggregate queries that group by family select on a created_at range first
-- and are served by idx_models_created.
--
-- So the index count is unchanged, the write cost is unchanged, and the four
-- queries above turn from a full scan of the unresolved set into a range seek
-- that reads the rows it asked for.
--
-- The fourth rung also carries `AND base_model IS NULL`. It is left to filter
-- that after the seek rather than given its own index, for the same reason:
-- another index would cost writes this database does not have to spare.

DROP INDEX IF EXISTS idx_models_family;

CREATE INDEX IF NOT EXISTS idx_models_unresolved
  ON hf_models (family, repo_id);
