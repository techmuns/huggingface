import { openSqliteD1, type SqliteD1 } from "../../src/lib/d1-sqlite";
import { CONFORMANCE_TABLE_SQL, describeD1Conformance, type D1Like } from "../d1-conformance";

/**
 * The same contract, against a local SQLite file.
 *
 * Every assertion here already passed against real D1 in
 * test/d1-binding.spec.ts. That ordering is the point: this suite is not
 * describing what the shim does, it is checking that the shim does what the
 * platform does.
 */
let db: SqliteD1 | null = null;

describeD1Conformance(
  "node:sqlite shim",
  () => {
    db ??= openSqliteD1(":memory:");
    return db as unknown as D1Like;
  },
  async () => {
    db ??= openSqliteD1(":memory:");
    db.exec(CONFORMANCE_TABLE_SQL);
    db.exec("DELETE FROM conformance");
  },
);
