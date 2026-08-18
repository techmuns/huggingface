import { type EntityKind, type HfClient, type HfRecord, MAX_PAGE_SIZE } from "./hf-api";
import { insertRawRecords } from "./raw-store";

/**
 * The paginated walk: fetch newest-first, store verbatim, stop at the window
 * edge.
 */

export interface IngestPageResult {
  /** 0-based index of the page just fetched. */
  page: number;
  /** Cursor for the next page, or null when the walk is finished. */
  nextCursor: string | null;
  recordsFetched: number;
  rowsWritten: number;
  /** Oldest `createdAt` seen on this page, ISO-8601, or null if none had one. */
  oldestCreatedAt: string | null;
  /** True once records predate the window, or the listing is exhausted. */
  done: boolean;
}

export interface IngestPageParams {
  db: D1Database;
  client: HfClient;
  kind: EntityKind;
  runId: string;
  /** Inclusive lower bound, ISO-8601. The walk stops once it reads past this. */
  since: string;
  cursor?: string | null;
  page?: number;
  pageSize?: number;
  now?: Date;
}

/**
 * Fetches and stores exactly one listing page.
 *
 * Deliberately one page per call so it maps onto one Workflow step. The
 * returned object is counts and a cursor — never the payload, which at 1,000
 * records would breach the 1 MiB cap on a step result on its own.
 */
export async function ingestPage(params: IngestPageParams): Promise<IngestPageResult> {
  const { db, client, kind, runId, since, cursor = null, page = 0 } = params;
  const fetchedAt = (params.now ?? new Date()).toISOString();

  const { records, nextCursor } = await client.listPage(kind, {
    cursor,
    limit: params.pageSize ?? MAX_PAGE_SIZE,
  });

  const rowsWritten = await insertRawRecords(db, { runId, kind, records, fetchedAt });
  const oldestCreatedAt = oldestCreated(records);

  // Stop when this page has reached past the window, or the Hub ran out of
  // records. Because the listing is sorted newest-first, every later page is
  // older still, so there is nothing in range left to find.
  //
  // The comparison is a plain string compare: `createdAt` is ISO-8601 UTC, so
  // lexical order is chronological order. The whole page is stored even when
  // it straddles the boundary — filtering happens at parse time, and throwing
  // away raw records we have already paid to fetch would be the one
  // irreversible mistake available here.
  const reachedWindowEdge = oldestCreatedAt !== null && oldestCreatedAt < since;

  return {
    page,
    nextCursor,
    recordsFetched: records.length,
    rowsWritten,
    oldestCreatedAt,
    done: reachedWindowEdge || nextCursor === null || records.length === 0,
  };
}

function oldestCreated(records: readonly HfRecord[]): string | null {
  let oldest: string | null = null;
  for (const record of records) {
    const createdAt = record.createdAt;
    if (typeof createdAt !== "string") continue;
    if (oldest === null || createdAt < oldest) oldest = createdAt;
  }
  return oldest;
}

/**
 * Guard against an unbounded walk.
 *
 * A week is ~28 pages of models and ~7 of Spaces, and a 12-week backfill is
 * ~400 in total. This cap sits far above that, so it only ever fires if the
 * cursor stops advancing — which would otherwise spin until the Workflow's
 * step or subrequest limits stopped it, much later and much less legibly.
 */
export const MAX_PAGES_PER_WALK = 900;
