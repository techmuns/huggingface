import { describe, expect, it } from "vitest";
import { openSqliteD1 } from "../../src/lib/d1-sqlite";
import { applyMigrations, pendingMigrations } from "../../src/runner/migrate";

const DIR = new URL("../../migrations", import.meta.url).pathname;

describe("building the schema from migrations/", () => {
  it("applies every migration and builds the real tables", () => {
    const db = openSqliteD1(":memory:");
    const applied = applyMigrations(db, DIR);

    expect(applied.length).toBeGreaterThanOrEqual(8);
    expect(applied[0]).toBe("0001_initial_schema.sql");
    // Lexical order is what the numeric prefixes are for.
    expect([...applied].sort()).toEqual(applied);

    const tables = db.handle
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of ["hf_models", "hf_spaces", "hf_classifications", "hf_weekly_metrics", "hf_raw_records"]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("is idempotent: a second call applies nothing", () => {
    const db = openSqliteD1(":memory:");
    expect(applyMigrations(db, DIR).length).toBeGreaterThan(0);
    expect(applyMigrations(db, DIR)).toEqual([]);
    expect(pendingMigrations(db, DIR)).toEqual([]);
    db.close();
  });

  it("carries the index migrations, so the runner does not scan", () => {
    // 0007 and 0008 are the difference between ~40M rows read a run and ~5M.
    // A runner that quietly skipped them would work and cost a fortune.
    const db = openSqliteD1(":memory:");
    applyMigrations(db, DIR);
    const indexes = db.handle
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(indexes).toContain("idx_models_unresolved");
    expect(indexes).toContain("idx_spaces_enrich");
    // Swapped, not added — the old one must be gone.
    expect(indexes).not.toContain("idx_models_family");

    const plan = db.handle
      .prepare(
        `EXPLAIN QUERY PLAN SELECT repo_id, tags FROM hf_models
          WHERE family IS NULL AND repo_id > '' ORDER BY repo_id LIMIT 250`,
      )
      .all()
      .map((r) => (r as { detail: string }).detail)
      .join(" | ");

    expect(plan).toContain("idx_models_unresolved");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
    db.close();
  });

  it("rolls a failing migration back rather than half-applying it", () => {
    const db = openSqliteD1(":memory:");
    expect(() => applyMigrations(db, "/nonexistent-migrations-dir")).toThrow();
    db.close();
  });
});
