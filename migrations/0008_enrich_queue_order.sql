-- The enrich queue sorted its whole backlog on every batch.
--
-- The query has not changed (src/lib/enrich.ts):
--
--     SELECT space_id, readme_hash FROM hf_spaces
--      WHERE signal_tier = 'blind' AND readme_status IS NULL
--      ORDER BY created_at DESC, space_id
--      LIMIT ?1 OFFSET ?2
--
-- and the index it had, (signal_tier, readme_status), served the WHERE but not
-- the ORDER BY. So SQLite seeked to the blind-and-unattempted rows, then
-- materialised and sorted all ~16,500 of them to hand back 150. Measured in
-- workerd against real D1: 24,001 rows read to return 150, on every one of
-- ~110 batches. 1.83 million rows a run.
--
-- IT WAS NEARLY FREE UNTIL TODAY, AND THAT IS THE UNCOMFORTABLE PART. The
-- README fetch had no token and no User-Agent, so it burned the Hub's
-- anonymous quota in under two minutes and every subsequent request came back
-- 429. Two runs enriched 2 and 8 Spaces out of ~14,000. A stage that fails on
-- its first batch does not run 110 of them.
--
-- Fixing the fetch is what arms this. The queue will genuinely drain for the
-- first time in the project's life, which means these batches will genuinely
-- run — and the read cost that was theoretical becomes 1.83M against a
-- free-plan ceiling of 5M a DAY. Shipping that fix without this one would have
-- traded a broken stage for a quota failure, and a quota failure is the worse
-- of the two: D1 returns an error that reads nothing like "you are out of
-- budget", and the pipeline has a long history of mistaking one failure for
-- another.
--
-- WIDENED, NOT ADDED. The index gains the two columns the ORDER BY needs, so
-- the seek and the ordering come from the same structure and the sort
-- disappears. Index COUNT on hf_spaces is unchanged, which is what keeps the
-- write side flat: D1 bills an extra written row per index whose column a
-- write touches, and the pipeline is at 77,570 writes against a 100,000
-- ceiling with no room for a fourth index on this table.
--
-- Measured both ways in workerd: an enrich UPDATE costs 2 rows_written with
-- the widened index and 2 with the original; an ingest upsert costs 2 and 2.
-- created_at and space_id never change after insert, so the added columns are
-- write-inert.
--
--     before   24,001 read / 150 returned, plus USE TEMP B-TREE FOR ORDER BY
--     after         150 read / 150 returned, no sort

DROP INDEX IF EXISTS idx_spaces_enrich;

CREATE INDEX IF NOT EXISTS idx_spaces_enrich
  ON hf_spaces (signal_tier, readme_status, created_at DESC, space_id);
