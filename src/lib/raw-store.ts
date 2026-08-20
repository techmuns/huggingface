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

export const D1_JSON_ARG_MAX_BYTES = 80_000;

/**
 * A record too large to ever be inserted alone.
 *
 * Nothing observed comes close — the largest measured is 19,963 bytes — but
 * `config` and `cardData` are free-form, so one pathological repo should cost
 * that one record rather than the whole week's ingest.
 */
export const D1_RECORD_MAX_BYTES = 90_000;

/**
 * Statements per `db.batch()` when each carries a large JSON argument.
 *
 * 10 x 80 KB keeps a batch request under ~800 KB. Separate from D1_BATCH,
 * which sizes batches of small per-row statements against the query count
 * rather than against request size.
 */
export const D1_STATEMENTS_PER_BATCH = 10;

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
 * How many bytes a string takes as UTF-8, without building it.
 *
 * The obvious `new TextEncoder().encode(s).length` allocates the entire
 * encoded buffer purely to read its length, and this is called once per
 * record — a walk of 7,000 records threw away 7,000 buffers, some of them
 * 20 KB, to learn seven thousand integers. A run that has to fit inside a CPU
 * ceiling should not be paying for that, and the garbage it makes is charged
 * to the same budget.
 *
 * Counting matches TextEncoder exactly, lone surrogates included: an unpaired
 * surrogate encodes as U+FFFD, which is three bytes, not the four a complete
 * pair would take. The tests check this function against TextEncoder rather
 * than against a table, so the two cannot drift.
 */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;                 // the pair is one code point
      } else {
        bytes += 3;          // lone high surrogate -> U+FFFD
      }
    } else {
      bytes += 3;            // includes lone low surrogates -> U+FFFD
    }
  }
  return bytes;
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
    const size = utf8Bytes(JSON.stringify(item));

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
    D1_JSON_ARG_MAX_BYTES,
    D1_RECORD_MAX_BYTES,
  );

  if (oversized.length > 0) {
    // Visible, not swallowed: the raw layer is the thing every later phase is
    // rebuilt from, so a gap in it has to be findable later.
    console.warn(
      `insertRawRecords: skipped ${oversized.length} ${kind} record(s) over ` +
        `${D1_RECORD_MAX_BYTES} bytes: ` +
        oversized
          .map((r) => (r as { id?: string }).id ?? "(no id)")
          .join(", "),
    );
  }

  const statements = chunks.map((batch) =>
    db.prepare(INSERT_SQL).bind(runId, kind, fetchedAt, JSON.stringify(batch)),
  );

  // Sent in groups rather than as one batch. Byte-sized chunks are smaller
  // than the old count-sized ones, so a page now produces several times as
  // many statements, and every one of them carries up to
  // D1_JSON_ARG_MAX_BYTES of JSON. One batch of all of them would be a
  // multi-megabyte request — a different limit from the per-statement one
  // just fixed, and not one worth discovering the same way.
  let written = 0;
  for (let i = 0; i < statements.length; i += D1_STATEMENTS_PER_BATCH) {
    const results = await db.batch(statements.slice(i, i + D1_STATEMENTS_PER_BATCH));
    written += results.reduce((total, r) => total + (r.meta?.changes ?? 0), 0);
  }
  return written;
}

/**
 * Deletes raw records older than the retention horizon.
 *
 * D1's 10 GB ceiling cannot be raised, so retention is a day-one policy
 * rather than something bolted on after it hurts. Anything dropped here has
 * already been archived to GitHub as a published weekly snapshot, and replay
 * beyond the horizon reads that archive instead.
 *
 * WHICH MAKES THE ARCHIVE A PRECONDITION, not a nicety. A snapshot commit can
 * fail on its own — an expired or under-scoped GITHUB_TOKEN returns 403 — and
 * the run now records that as `snapshot.committed: false` and carries on,
 * because the week's metrics are already written and the dashboard is already
 * correct. Nothing calls this function yet; whatever eventually does MUST
 * refuse to prune a week whose snapshot never landed, or this comment becomes
 * the description of a data-loss bug rather than of a retention policy.
 */
export async function pruneRawRecords(db: D1Database, olderThanIso: string): Promise<number> {
  const result = await db
    .prepare("delete from hf_raw_records where fetched_at < ?1")
    .bind(olderThanIso)
    .run();
  return result.meta?.changes ?? 0;
}
