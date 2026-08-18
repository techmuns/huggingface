import type { EntityKind, HfRecord } from "./hf-api";

/**
 * Writes to `hf_raw_records`, the immutable append-only layer every later
 * phase is rebuilt from.
 */

/**
 * Records per INSERT statement.
 *
 * D1 allows only **100 bound parameters per query**, so the obvious
 * multi-row `VALUES (?,?,?,?,?), (?,?,?,?,?) ...` form caps out at 20 records
 * per statement — 50 statements per 1,000-record page, which would put a
 * week's models near the 1,000-queries-per-invocation ceiling for no reason.
 *
 * Passing the whole chunk as one JSON array and expanding it with
 * `json_each` uses **four** bound parameters no matter how many records it
 * carries, which decouples batch size from that limit entirely.
 *
 * 250 is then chosen against the *other* two limits rather than the
 * parameter one: it keeps the JSON argument around 60 KB, comfortably inside
 * both the 100 KB statement bound and the 2 MB maximum string size, with
 * enough headroom that an unusually fat page cannot push a statement over.
 */
export const RAW_INSERT_CHUNK = 250;

const INSERT_SQL = `
  insert into hf_raw_records (run_id, entity_kind, entity_id, fetched_at, payload)
  select ?1, ?2, json_extract(j.value, '$.id'), ?3, j.value
  from json_each(?4) as j
  where json_extract(j.value, '$.id') is not null
`;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Appends a page of listing records verbatim, before any parsing.
 *
 * A parser bug must never cost a re-fetch: Spaces get deleted and privatised,
 * so a record not captured on the day it appeared may be unobtainable later.
 * Records without an `id` are skipped rather than stored, because the raw
 * layer is keyed by entity and an unidentifiable payload could never be
 * replayed into anything.
 *
 * @returns the number of rows actually written.
 */
export async function insertRawRecords(
  db: D1Database,
  params: {
    runId: string;
    kind: EntityKind;
    records: readonly HfRecord[];
    fetchedAt: string;
  },
): Promise<number> {
  const { runId, kind, records, fetchedAt } = params;
  if (records.length === 0) return 0;

  const statements = chunk(records, RAW_INSERT_CHUNK).map((batch) =>
    db.prepare(INSERT_SQL).bind(runId, kind, fetchedAt, JSON.stringify(batch)),
  );

  const results = await db.batch(statements);
  return results.reduce((total, r) => total + (r.meta?.changes ?? 0), 0);
}

/**
 * Deletes raw records older than the retention horizon.
 *
 * D1's 10 GB ceiling cannot be raised, so retention is a day-one policy
 * rather than something bolted on after it hurts. Anything dropped here has
 * already been archived to GitHub as a published weekly snapshot, and replay
 * beyond the horizon reads that archive instead.
 */
export async function pruneRawRecords(db: D1Database, olderThanIso: string): Promise<number> {
  const result = await db
    .prepare("delete from hf_raw_records where fetched_at < ?1")
    .bind(olderThanIso)
    .run();
  return result.meta?.changes ?? 0;
}
