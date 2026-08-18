/**
 * Parses raw records into typed tables via SQL INSERT…SELECT.
 *
 * The raw layer is immutable and append-only; the typed tables are the
 * queryable, updateable view every later phase works against.  ON CONFLICT
 * upserts so a re-run or the 0.2% cursor-resurfaced duplicates are absorbed.
 */

export interface ParseSummary {
  models: number;
  spaces: number;
}

const PARSE_MODELS_SQL = `
  INSERT INTO hf_models (
    repo_id, author, created_at, last_modified,
    downloads, downloads_all_time, likes,
    pipeline_tag, library_name, tags,
    first_seen_at, updated_at
  )
  SELECT
    json_extract(payload, '$.id'),
    json_extract(payload, '$.author'),
    COALESCE(json_extract(payload, '$.createdAt'), fetched_at),
    json_extract(payload, '$.lastModified'),
    CAST(COALESCE(json_extract(payload, '$.downloads'), 0) AS INTEGER),
    CAST(json_extract(payload, '$.downloadsAllTime') AS INTEGER),
    CAST(COALESCE(json_extract(payload, '$.likes'), 0) AS INTEGER),
    json_extract(payload, '$.pipeline_tag'),
    json_extract(payload, '$.library_name'),
    COALESCE(json_extract(payload, '$.tags'), '[]'),
    fetched_at,
    fetched_at
  FROM hf_raw_records
  WHERE entity_kind = 'model' AND run_id = ?1
    AND json_extract(payload, '$.id') IS NOT NULL
  ON CONFLICT(repo_id) DO UPDATE SET
    last_modified = COALESCE(excluded.last_modified, hf_models.last_modified),
    downloads = excluded.downloads,
    downloads_all_time = COALESCE(excluded.downloads_all_time, hf_models.downloads_all_time),
    likes = excluded.likes,
    pipeline_tag = COALESCE(excluded.pipeline_tag, hf_models.pipeline_tag),
    library_name = COALESCE(excluded.library_name, hf_models.library_name),
    tags = excluded.tags,
    updated_at = excluded.updated_at
`;

const PARSE_SPACES_SQL = `
  INSERT INTO hf_spaces (
    space_id, author, created_at, last_modified, likes,
    title, short_description, sdk, tags,
    linked_models, linked_datasets,
    signal_tier,
    first_seen_at, updated_at
  )
  SELECT
    json_extract(payload, '$.id'),
    json_extract(payload, '$.author'),
    COALESCE(json_extract(payload, '$.createdAt'), fetched_at),
    json_extract(payload, '$.lastModified'),
    CAST(COALESCE(json_extract(payload, '$.likes'), 0) AS INTEGER),
    json_extract(payload, '$.cardData.title'),
    json_extract(payload, '$.cardData.short_description'),
    json_extract(payload, '$.sdk'),
    COALESCE(json_extract(payload, '$.tags'), '[]'),
    COALESCE(json_extract(payload, '$.models'), '[]'),
    COALESCE(json_extract(payload, '$.datasets'), '[]'),
    CASE
      WHEN json_extract(payload, '$.cardData.short_description') IS NOT NULL
        AND length(json_extract(payload, '$.cardData.short_description')) > 0
      THEN 'rich'
      WHEN json_array_length(COALESCE(json_extract(payload, '$.models'), '[]')) > 0
      THEN 'rich'
      ELSE 'blind'
    END,
    fetched_at,
    fetched_at
  FROM hf_raw_records
  WHERE entity_kind = 'space' AND run_id = ?1
    AND json_extract(payload, '$.id') IS NOT NULL
  ON CONFLICT(space_id) DO UPDATE SET
    last_modified = COALESCE(excluded.last_modified, hf_spaces.last_modified),
    likes = excluded.likes,
    title = COALESCE(excluded.title, hf_spaces.title),
    short_description = COALESCE(excluded.short_description, hf_spaces.short_description),
    sdk = COALESCE(excluded.sdk, hf_spaces.sdk),
    tags = excluded.tags,
    linked_models = excluded.linked_models,
    linked_datasets = excluded.linked_datasets,
    signal_tier = excluded.signal_tier,
    updated_at = excluded.updated_at
`;

export async function parseRawModels(db: D1Database, runId: string): Promise<number> {
  const result = await db.prepare(PARSE_MODELS_SQL).bind(runId).run();
  return result.meta?.changes ?? 0;
}

export async function parseRawSpaces(db: D1Database, runId: string): Promise<number> {
  const result = await db.prepare(PARSE_SPACES_SQL).bind(runId).run();
  return result.meta?.changes ?? 0;
}
