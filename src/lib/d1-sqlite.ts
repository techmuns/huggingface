/**
 * A `D1Database` backed by a local SQLite file, for running the pipeline
 * outside Workers.
 *
 * D1 *is* SQLite, so this is not an emulation — it is the same engine reached
 * through a different door. Every query in `src/lib` runs against it
 * unchanged: same SQL, same `?N` placeholders, same `STRICT` tables, same
 * `EXPLAIN QUERY PLAN`.
 *
 * WHY THIS EXISTS. The pipeline outgrew what a free Cloudflare account will do.
 * A Workflow step gets 10 ms of CPU, and four separate step bodies had to be
 * measured and cut to fit inside it. D1 bills rows READ, and one run read 19.5
 * million against a ceiling of 5 million a day. Neither limit is about the
 * code being wrong; they are the shape of the platform, and the pipeline is
 * simply the wrong shape for it — a weekly batch job that walks a hundred
 * thousand records is not a request-response workload.
 *
 * The alternative considered first was talking to D1 over its REST API from a
 * runner. That would have meant a hand-written HTTP client, an account-wide
 * rate limit of 1,200 requests per five minutes, ~250 ms a query from an APAC
 * database, and a wire format that types bound parameters as strings — against
 * `STRICT` tables, where a number arriving as text is a silent wrong answer
 * rather than an error. A local file has none of those properties.
 *
 * WHAT IS DELIBERATELY NOT HERE. Only the surface `src/lib` actually uses:
 * `prepare`, `bind`, `all`, `first`, `run` and `batch`, and of the metadata
 * only `changes`, which `batchExec` reads. `dump`, `exec`, sessions and
 * bookmarks are absent because nothing calls them, and a stub that silently
 * did the wrong thing would be worse than a missing method. The cast at the
 * bottom is where that narrowing is acknowledged rather than hidden.
 *
 * `node:sqlite` is synchronous. The D1 interface is not, so every method
 * returns an already-resolved promise. That costs a microtask and keeps the
 * call sites identical.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

/** What `bind()` accepts, and what SQLite will store. */
type Bindable = string | number | bigint | null | Uint8Array;

interface RunMeta {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
}

function meta(changes = 0, lastRowId = 0): RunMeta {
  return {
    changes,
    last_row_id: lastRowId,
    duration: 0,
    // Reported as zero rather than guessed. D1 counts rows scanned, which
    // SQLite will not tell us without `sqlite3_stmt_status`, and a plausible
    // wrong number here would be worse than an obviously absent one — the
    // whole reason this file exists is a read count nobody was measuring.
    rows_read: 0,
    rows_written: 0,
  };
}

class SqliteStatement {
  constructor(
    private readonly compile: (sql: string) => StatementSync,
    private readonly sql: string,
    private readonly args: readonly Bindable[] = [],
  ) {}

  /** D1's `bind` returns a NEW statement; reusing one must not accumulate. */
  bind(...values: Bindable[]): SqliteStatement {
    return new SqliteStatement(this.compile, this.sql, values);
  }

  async all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: true;
    meta: RunMeta;
  }> {
    const rows = this.compile(this.sql).all(...this.args) as T[];
    return { results: rows, success: true, meta: meta() };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.compile(this.sql).get(...this.args) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    if (column === undefined) return row as T;
    return (row[column] ?? null) as T;
  }

  async run(): Promise<{ success: true; meta: RunMeta }> {
    const r = this.compile(this.sql).run(...this.args);
    return { success: true, meta: meta(Number(r.changes), Number(r.lastInsertRowid)) };
  }

  /** Used by the batch path to execute without allocating a result object. */
  execute(): number {
    return Number(this.compile(this.sql).run(...this.args).changes);
  }
}

export interface SqliteD1 {
  prepare(sql: string): SqliteStatement;
  batch<T = unknown>(
    statements: SqliteStatement[],
  ): Promise<Array<{ results: T[]; success: true; meta: RunMeta }>>;
  /** Runs raw SQL. Used to apply migrations, never by `src/lib`. */
  exec(sql: string): void;
  close(): void;
  /** The underlying handle, for VACUUM, backup and the like. */
  readonly handle: DatabaseSync;
}

export function openSqliteD1(path: string): SqliteD1 {
  const db = new DatabaseSync(path);

  // Durability is the runner's job, not SQLite's: the file is snapshotted
  // after the run, and a crash mid-run is recovered by re-running, which every
  // stage is already built for. WAL and a relaxed sync are worth roughly an
  // order of magnitude on the bulk upserts that dominate ingest.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Compiling the same SQL thousands of times is the one place this shim could
  // be slower than the binding. The pipeline issues a few dozen distinct
  // statements against hundreds of thousands of rows, so the cache is small
  // and its hit rate is essentially total.
  const compiled = new Map<string, StatementSync>();
  const compile = (sql: string): StatementSync => {
    let stmt = compiled.get(sql);
    if (stmt === undefined) {
      stmt = db.prepare(sql);
      compiled.set(sql, stmt);
    }
    return stmt;
  };

  return {
    prepare: (sql: string) => new SqliteStatement(compile, sql),

    async batch<T = unknown>(statements: SqliteStatement[]) {
      // D1 documents batch() as a transaction that rolls the whole sequence
      // back if any statement fails. Matched exactly, because callers rely on
      // it: a half-applied page of classifications looks identical to a
      // drained queue to the loop that selects the next one.
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => ({
          results: [] as T[],
          success: true as const,
          meta: meta(s.execute()),
        }));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
    handle: db,
  };
}

/**
 * Hands the shim to code typed against `D1Database`.
 *
 * A cast rather than an `implements`, and deliberately so: `D1Database`
 * declares members this does not have, and pretending otherwise would mean
 * writing stubs for `dump` and the session API that no caller wants and that
 * could only ever fail confusingly. Everything `src/lib` reaches for is
 * implemented above; this function is the single place that claim is made, so
 * it is the single place to look if it ever stops being true.
 */
export function asD1(db: SqliteD1): D1Database {
  return db as unknown as D1Database;
}
