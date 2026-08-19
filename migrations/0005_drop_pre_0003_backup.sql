-- Drops the rollback copy 0003 left behind.
--
-- 0003 renames the old hf_models to hf_models_pre_0003 instead of dropping it,
-- because D1's Time Travel restore is a paid feature and the rebuild has no
-- other recovery point on the Free plan. That copy is insurance, not schema —
-- it should not outlive the verification it exists for.
--
-- Apply this only AFTER confirming the rebuild kept every row:
--     SELECT (SELECT COUNT(*) FROM hf_models)
--          = (SELECT COUNT(*) FROM hf_models_pre_0003) AS rows_match;
-- A fresh database applies 0003 and 0005 back to back and ends clean, so the
-- canonical schema never carries the backup.

DROP TABLE IF EXISTS hf_models_pre_0003;
