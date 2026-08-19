import type { EntityKind, HfRecord } from "./hf-api";

/**
 * Writes to `hf_raw_records`, the immutable append-only layer every later
 * phase is rebuilt from.
 */

/**
 * Byte budget for the JSON argument of one INSERT.
 *
 * D1 allows only **100 bound parameters per query**, so the obvious
 * multi-row `VALUES (?,?,?,?,?), (?,?,?,?,?) ...` form caps out at 20 records
 * per statement. Passing the whole chunk as one JSON array and expanding it
 * with `json_each` uses **four** bound parameters no matter how many records
 * it carries, which decouples batch size from that limit entirely.
 *
 * What it does NOT decouple is statement size, and that is what a fixed
 * record count got wrong. This was 250 records, documented as "around 60 KB",
 * which was true when it was written. Then `config` joined the model expand
 * list and every record grew: measured against the live API, 250 records is
 * now **518,088 bytes** — 5.2x past D1's 100,000-byte statement limit — and
 * ingest died with `D1_ERROR: string or blob too big: SQLITE_TOOBIG`.
 *
 * A count cannot be safe here. Measured record sizes run 254 bytes to 19,963,
 * a 78x spread, and the expand list is expected to change again. So the chunk
 * is sized by serialized bytes instead, which stays correct without anyone
 * remembering to re-measure.
 *
 * 80 KB leaves room for the statement text and the other three bound values
 * inside the 100 KB bound.
 */
/**
 * Statements per D1 batch.
 *
 * Sized for the Workers **Free** plan, which allows 50 queries per Worker
 * invocation — not the 1,000 the paid plan allows. Every batching decision in
 * this project was originally made against the 1,000 figure, which fails on
 * Free at exactly the stages that write per row.
 */
export const D1_BATCH = 40;

export const RAW_INSERT_MAX_BYTES = 80_000;

/**
 * A record too large to ever be inserted alone.
 *
 * Nothing observed comes close — the largest measured is 19,963 bytes — but
 * `config` and `cardData` are free-form, so one pathological repo should cost
 * that one record rather than the whole week's ingest.
 */
export const RAW_RECORD_MAX_BYTES = 90_000;

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
 * Groups records so each group's `JSON.stringify` stays under `maxBytes`.
 *
 * Measures the serialized length of each record rather than assuming a size,
 * because that assumption is exactly what broke: record sizes vary 78x and
 * grew silently when a field was added to the API request.
 *
 * Records that exceed `RAW_RECORD_MAX_BYTES` on their own are returned
 * separately rather than emitted in a doomed statement. Losing one repo is a
 * bad outcome; losing the week's ingest to it is a worse one, and a silent
 * drop is worse than both — hence returned, counted, and reported by the
 * caller.
 */
export function chunkByBytes<T>(
  items: readonly T[],
  maxBytes: number,
  maxRecordBytes: number,
): { chunks: T[][]; oversized: T[] } {
  if (maxBytes < 1) throw new RangeError(`maxBytes must be >= 1, got ${maxBytes}`);

  const chunks: T[][] = [];
  const oversized: T[] = [];
  let current: T[] = [];
  // Starts at 2 for the enclosing `[]`; each subsequent element adds a comma.
  let currentBytes = 2;

  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).length;

    if (size > maxRecordBytes) {
      oversized.push(item);
      continue;
    }

    // +1 for the separating comma once the group is non-empty.
    const added = size + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentBytes + added > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }

    current.push(item);
    currentBytes += size + (current.length > 1 ? 1 : 0);
  }

  if (current.length > 0) chunks.push(current);
  return { chunks, oversized };
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

  const { chunks, oversized } = chunkByBytes(
    records,
    RAW_INSERT_MAX_BYTES,
    RAW_RECORD_MAX_BYTES,
  );

  if (oversized.length > 0) {
    // Visible, not swallowed: the raw layer is the thing every later phase is
    // rebuilt from, so a gap in it has to be findable later.
    console.warn(
      `insertRawRecords: skipped ${oversized.length} ${kind} record(s) over ` +
        `${RAW_RECORD_MAX_BYTES} bytes: ` +
        oversized
          .map((r) => (r as { id?: string }).id ?? "(no id)")
          .join(", "),
    );
  }

  const statements = chunks.map((batch) =>
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
