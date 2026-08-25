/**
 * One contract, two runtimes.
 *
 * `src/lib` is written against `D1Database` and now runs in two places: inside
 * workerd against a real D1 binding, and on a Node runner against a local
 * SQLite file (`src/lib/d1-sqlite.ts`). This file is the agreement between
 * them, and it is deliberately run against BOTH.
 *
 * The binding is the oracle, not the shim. Every assertion here has to pass
 * against real D1 first; if one cannot be made to, the assertion is wrong and
 * the shim would have been built to a specification the platform does not
 * honour. That ordering is the whole point — the alternative plan, talking to
 * D1 over its REST API, was rejected largely because its wire format types
 * bound parameters as strings, and a number arriving as text into a `STRICT`
 * table is a silent wrong answer rather than an error. So the first thing
 * checked here is types.
 *
 * Everything asserted is something `src/lib` actually depends on. Nothing is
 * here to describe SQLite in general.
 */

import { describe, expect, it, beforeEach } from "vitest";

/** The subset of D1 this project uses, as the shared code sees it. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: never[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
    run(): Promise<{ meta?: { changes?: number } }>;
  };
  batch<T = unknown>(statements: unknown[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

const TABLE = `CREATE TABLE IF NOT EXISTS conformance (
  id     TEXT PRIMARY KEY,
  n      INTEGER,
  r      REAL,
  txt    TEXT,
  flag   INTEGER NOT NULL DEFAULT 0
) STRICT`;

/**
 * @param label      which runtime this is, for the suite name
 * @param getDb      the database under test
 * @param resetSql   statements to run before each case, in order
 */
export function describeD1Conformance(
  label: string,
  getDb: () => D1Like,
  reset: (db: D1Like) => Promise<void>,
): void {
  describe(`D1 conformance: ${label}`, () => {
    let db: D1Like;

    beforeEach(async () => {
      db = getDb();
      await reset(db);
    });

    const bind = (sql: string, ...v: unknown[]) =>
      (db.prepare(sql).bind as (...a: unknown[]) => ReturnType<typeof db.prepare>)(...v);

    it("stores a bound number as a number, not as text", async () => {
      // The failure this guards: `STRICT` rejects TEXT in an INTEGER column, so
      // a runtime that stringifies bound params errors here — and one that
      // coerces instead would put '7' where 7 belongs and quietly change every
      // comparison downstream.
      await bind(
        `INSERT INTO conformance (id, n, r, txt) VALUES (?1, ?2, ?3, ?4)`,
        "a", 7, 1.5, "hello",
      ).run();

      const row = await bind(
        `SELECT n, r, txt FROM conformance WHERE id = ?1`,
        "a",
      ).first<{ n: number; r: number; txt: string }>();

      expect(typeof row?.n).toBe("number");
      expect(typeof row?.r).toBe("number");
      expect(row?.n).toBe(7);
      expect(row?.r).toBe(1.5);
      expect(row?.txt).toBe("hello");
    });

    it("round-trips null as null, not as the string 'null'", async () => {
      // enrich.ts binds `result.text`, which is `string | null`. The column is
      // TEXT, so `STRICT` would NOT catch a four-character 'null' — and
      // readme_hash is written alongside it, so every later run would see an
      // unchanged hash and skip that Space forever. Self-sealing corruption.
      await bind(
        `INSERT INTO conformance (id, n, txt) VALUES (?1, ?2, ?3)`,
        "b", null, null,
      ).run();

      const row = await bind(
        `SELECT n, txt FROM conformance WHERE id = ?1`,
        "b",
      ).first<{ n: number | null; txt: string | null }>();

      expect(row?.n).toBeNull();
      expect(row?.txt).toBeNull();
    });

    it("reports meta.changes per statement, not cumulatively", async () => {
      // Ten call sites sum `result.meta?.changes ?? 0` — raw-store, parse,
      // aggregate, model-family, enrich. If this were a connection-level
      // running total, every one of those counts would inflate while staying
      // plausible, and they are the numbers that reveal whether a run did any
      // work at all.
      for (const id of ["c1", "c2", "c3"]) {
        await bind(`INSERT INTO conformance (id, n) VALUES (?1, 1)`, id).run();
      }

      const first = await db.prepare(`UPDATE conformance SET n = n + 1`).run();
      expect(first.meta?.changes).toBe(3);

      const second = await bind(
        `UPDATE conformance SET n = n + 1 WHERE id = ?1`,
        "c1",
      ).run();
      expect(second.meta?.changes).toBe(1);
    });

    it("binds the same placeholder in several positions", async () => {
      // classify-rules binds `result.rationale` twice in one statement.
      await bind(
        `INSERT INTO conformance (id, txt, n) VALUES (?1, ?1, ?2)`,
        "dup", 3,
      ).run();

      const row = await bind(
        `SELECT id, txt FROM conformance WHERE id = ?1`,
        "dup",
      ).first<{ id: string; txt: string }>();

      expect(row?.txt).toBe("dup");
    });

    it("accepts numbers bound into LIMIT", async () => {
      // Every paged walk in the pipeline does this — the resolver, the rules
      // pass, dedup, enrich. If LIMIT will not take a bound number the whole
      // cursor design collapses.
      for (const id of ["l1", "l2", "l3", "l4"]) {
        await bind(`INSERT INTO conformance (id, n) VALUES (?1, 1)`, id).run();
      }

      const page = await bind(
        `SELECT id FROM conformance WHERE id > ?1 ORDER BY id LIMIT ?2`,
        "", 2,
      ).all<{ id: string }>();

      expect(page.results).toHaveLength(2);
      expect(page.results.map((r) => r.id)).toEqual(["l1", "l2"]);
    });

    it("preserves row order so a cursor can take the last row", async () => {
      // Three walks advance by reading the LAST element of the results array —
      // classify-rules, enrich's dedup page, and the resolver. A runtime that
      // did not preserve ORDER BY through its result envelope would make the
      // cursor jump backwards (spinning to the cap) or forwards (rows never
      // examined, then published as unresolved).
      for (const id of ["r3", "r1", "r4", "r2"]) {
        await bind(`INSERT INTO conformance (id, n) VALUES (?1, 1)`, id).run();
      }

      const rows = await db
        .prepare(`SELECT id FROM conformance ORDER BY id`)
        .all<{ id: string }>();

      expect(rows.results.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
      expect(rows.results[rows.results.length - 1]?.id).toBe("r4");
    });

    it("returns an empty results array rather than undefined when nothing matches", async () => {
      // Every caller writes `rows.results ?? []` and then checks `.length`, and
      // a short page is what stops the batch loops. Getting this wrong ends a
      // walk early and reports the queue as drained.
      const rows = await bind(
        `SELECT id FROM conformance WHERE id = ?1`,
        "nothing-here",
      ).all<{ id: string }>();

      expect(Array.isArray(rows.results)).toBe(true);
      expect(rows.results).toHaveLength(0);
    });

    it("returns null from first() when there is no row", async () => {
      const row = await bind(
        `SELECT id FROM conformance WHERE id = ?1`,
        "absent",
      ).first<{ id: string }>();

      expect(row).toBeNull();
    });

    it("applies a batch as one transaction and rolls the whole thing back", async () => {
      // The bulk upserts depend on this. A half-applied page of classifications
      // is indistinguishable from a drained queue to the loop that selects the
      // next page, so a partial batch is not a smaller success — it is a
      // silently short week.
      await bind(`INSERT INTO conformance (id, n) VALUES (?1, 1)`, "keep").run();

      const statements = [
        db.prepare(`INSERT INTO conformance (id, n) VALUES ('t1', 1)`),
        // Violates the primary key, so the batch must fail as a whole.
        db.prepare(`INSERT INTO conformance (id, n) VALUES ('keep', 1)`),
        db.prepare(`INSERT INTO conformance (id, n) VALUES ('t2', 1)`),
      ];

      await expect(db.batch(statements)).rejects.toThrow();

      const after = await db
        .prepare(`SELECT id FROM conformance ORDER BY id`)
        .all<{ id: string }>();
      expect(after.results.map((r) => r.id)).toEqual(["keep"]);
    });

    it("applies a successful batch in order and reports each statement's changes", async () => {
      const results = await db.batch([
        db.prepare(`INSERT INTO conformance (id, n) VALUES ('b1', 1)`),
        db.prepare(`INSERT INTO conformance (id, n) VALUES ('b2', 1)`),
        db.prepare(`UPDATE conformance SET n = 5`),
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]?.meta?.changes).toBe(1);
      expect(results[1]?.meta?.changes).toBe(1);
      expect(results[2]?.meta?.changes).toBe(2);
    });

    it("honours ON CONFLICT DO UPDATE, which every ingest write relies on", async () => {
      await bind(
        `INSERT INTO conformance (id, n) VALUES (?1, ?2)`,
        "up", 1,
      ).run();
      await bind(
        `INSERT INTO conformance (id, n) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET n = excluded.n`,
        "up", 9,
      ).run();

      const row = await bind(
        `SELECT n FROM conformance WHERE id = ?1`,
        "up",
      ).first<{ n: number }>();
      expect(row?.n).toBe(9);
    });

    it("supports json_each, which the bulk insert path uses", async () => {
      const rows = await bind(
        `SELECT value AS v FROM json_each(?1) ORDER BY value`,
        JSON.stringify(["x", "y", "z"]),
      ).all<{ v: string }>();

      expect(rows.results.map((r) => r.v)).toEqual(["x", "y", "z"]);
    });

    it("rejects a text value in an INTEGER column, proving STRICT is on", async () => {
      // If this passes silently the table is not STRICT, and every other type
      // assertion in this file is worth less than it looks.
      await expect(
        bind(
          `INSERT INTO conformance (id, n) VALUES (?1, ?2)`,
          "bad", "not-a-number",
        ).run(),
      ).rejects.toThrow();
    });

    it("bind() returns a fresh statement rather than mutating the prepared one", async () => {
      // The pipeline prepares once and binds per row in tight loops. If bind()
      // mutated in place, every statement in a batch would carry the last
      // row's values — and the batch would still succeed.
      const stmt = db.prepare(`INSERT INTO conformance (id, n) VALUES (?1, ?2)`);
      const one = (stmt.bind as (...a: unknown[]) => typeof stmt)("f1", 1);
      const two = (stmt.bind as (...a: unknown[]) => typeof stmt)("f2", 2);

      await db.batch([one, two]);

      const rows = await db
        .prepare(`SELECT id, n FROM conformance ORDER BY id`)
        .all<{ id: string; n: number }>();
      expect(rows.results).toEqual([
        { id: "f1", n: 1 },
        { id: "f2", n: 2 },
      ]);
    });
  });
}

export const CONFORMANCE_TABLE_SQL = TABLE;
