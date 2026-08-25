import { env } from "cloudflare:test";
import { CONFORMANCE_TABLE_SQL, describeD1Conformance, type D1Like } from "./d1-conformance";

/**
 * The contract, against real D1 in real workerd.
 *
 * This is the oracle. The same suite runs against the SQLite shim in
 * test/node/d1-sqlite.spec.ts, and any assertion that cannot pass HERE is a
 * wrong assertion — not a shim bug.
 */
describeD1Conformance(
  "workerd + D1 binding",
  () => env.DB as unknown as D1Like,
  async (db) => {
    await (db as unknown as D1Database).exec(
      CONFORMANCE_TABLE_SQL.replace(/\s+/g, " "),
    );
    await (db as unknown as D1Database).prepare("DELETE FROM conformance").run();
  },
);
