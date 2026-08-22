-- An index for the use-case drill-down: the new Spaces that got any traction.
--
-- The drill-down asks a question the dashboard could not answer before: inside
-- one use case, in one span of weeks, which new Spaces did anyone actually
-- notice? Without an index for it the query drives off the classification
-- table, fetches every classified Space in the window by primary key, and then
-- sorts the lot in a temp B-tree:
--
--   SEARCH c USING INDEX idx_class_taxonomy_usecase
--   SEARCH s USING INDEX sqlite_autoindex_hf_spaces_1 (space_id=?)
--   USE TEMP B-TREE FOR ORDER BY                       -- 35.8 ms median
--
-- With this index SQLite drives off hf_spaces instead, walks the likes order
-- it needs, and the sort disappears:
--
--   SEARCH s USING INDEX idx_spaces_traction (ANY(likes) AND created_at>? AND created_at<?)
--   SEARCH c USING INDEX sqlite_autoindex_hf_classifications_1
--                                                      -- 1.0 ms median
--
-- Measured over a 312,000-row fixture built to the real distribution: 78 weeks
-- at 4,000 new Spaces a week, 95.5% of them with zero likes, half classified.
-- That is well ahead of where the live table is, and D1 is single-threaded, so
-- a page-load query that sorts a quarter of a million rows is not something to
-- find out about later.
--
-- PARTIAL, on both conditions the endpoint always applies. That is what keeps
-- it small: only 14,093 of those 312,000 rows have a like at all — 4.5% — so
-- the index covers the 4.5% anyone will ever ask about and ignores the rest.
--
-- COST: one index build over hf_spaces. No table rewrite, no column change,
-- nothing destructive; safe to apply with a run in flight.

CREATE INDEX IF NOT EXISTS idx_spaces_traction
  ON hf_spaces (likes DESC, created_at DESC, space_id)
  WHERE likes > 0 AND is_cluster_primary = 1;
