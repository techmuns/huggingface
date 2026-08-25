import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteD1 } from "../lib/d1-sqlite";

/**
 * Applies `migrations/*.sql` to a local SQLite database.
 *
 * Wrangler does this for D1 and tracks what it has applied in a table called
 * `d1_migrations`. The runner needs the same thing for a file it owns, and it
 * uses the same table name on purpose: a database exported from D1 and opened
 * here is already correctly marked, and one built here could be imported back
 * without wrangler trying to re-run everything.
 *
 * Ordering is lexical, which is what the numeric filename prefixes are for.
 * Each file runs inside a transaction so a migration that fails halfway leaves
 * nothing behind — `0007` and `0008` are each a DROP INDEX followed by a
 * CREATE INDEX, and a database with the old index dropped and the new one
 * missing would silently go back to full table scans.
 */

const TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`;

export function pendingMigrations(db: SqliteD1, dir: string): string[] {
  db.exec(TABLE);
  const applied = new Set(
    db.handle
      .prepare("SELECT name FROM d1_migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !applied.has(f));
}

export function applyMigrations(db: SqliteD1, dir: string): string[] {
  const pending = pendingMigrations(db, dir);

  for (const name of pending) {
    const sql = readFileSync(join(dir, name), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.handle.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }

  return pending;
}
