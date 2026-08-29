-- Which classifier produced a classification.
--
-- WHY. Two published weeks were classified by different code and nothing
-- recorded it. The symptom is in the shipped data: share_by_use_case
-- scientific-tools reads 20.18 / 0.96 / 3.00 / 3.01 across 2026-07-27 ..
-- 2026-08-17 — a 6.7x cliff that no coverage curve can produce. Commits
-- dfe6dd1 (two classification regexes were matching a literal backslash, so an
-- entire rule was dead) and 04de6b6 (the rules page size, which changed how
-- many Spaces the rule pass reached at all) both changed what a classifier
-- returns for the same Space, while TAXONOMY_VERSION stayed "1".
--
-- TAXONOMY_VERSION cannot do this job. It versions the SHAPE of the answer —
-- the list of use cases, verticals and technologies — and it must stay stable
-- while the classifier improves, because a taxonomy change means the old rows
-- are about something else entirely. A classifier change means the old rows are
-- about the same thing, measured differently. The dashboard has to be able to
-- tell those apart, and refuse a comparison across the second kind.
--
-- NULL is meaningful: it marks every row written before this column existed,
-- which is to say every row whose classifier is unknown. It is not backfilled
-- to a guess.
--
-- COST: one nullable column, no rewrite of existing rows, no index.
ALTER TABLE hf_classifications ADD COLUMN classifier_version TEXT;

-- Reading a week's classifier mix is a per-week question, and the join it needs
-- is the same one coverage already makes.
CREATE INDEX IF NOT EXISTS idx_classifications_version
  ON hf_classifications (taxonomy_version, classifier_version);
