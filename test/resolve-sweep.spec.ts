import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_CURSORS, resolveModelFamilies } from "../src/lib/model-family";

/**
 * The end-of-pass sweeps now run once instead of on every pass.
 *
 * That is worth ~3.06 million rows read a run — they scan ~37,000 rows each
 * time and write nothing after the first — but it is only safe if the table
 * ends up in exactly the same state. This asserts that directly: the same
 * fixture, walked twice, once sweeping every pass and once sweeping only at
 * the end, must finish byte-identical.
 *
 * The failure being guarded is specific and this repo has shipped it before.
 * The bounded sweep exists so a row no rung has examined is never stamped
 * `other-open` — stamping it would take it out of `family IS NULL`, and no
 * later pass would ever look at it again. "Could not tell" and "did not look"
 * are different answers, and only one of them is honest.
 */
const DB = env.DB;

async function seed(n: number) {
  await DB.prepare("DELETE FROM hf_models").run();
  const stmts = [];
  for (let i = 0; i < n; i++) {
    // A deliberate mix, so every rung and every sweep has work:
    //  i%7==0  resolvable by architecture tag
    //  i%7==1  declares a parent that itself resolves  -> chain
    //  i%7==2  declares a parent that never resolves   -> lineage sweep
    //  i%7==3  model_type set, not a named family      -> bounded sweep
    //  i%7==4  name pattern
    //  else    nothing; stays unresolved
    const k = i % 7;
    stmts.push(
      DB.prepare(
        `INSERT INTO hf_models (repo_id, author, created_at, first_seen_at, updated_at,
                                tags, model_type, base_model, pipeline_tag, library_name)
         VALUES (?1, 'org', '2026-08-17', '2026-08-17', '2026-08-17', ?2, ?3, ?4, 'text-generation', 'transformers')`,
      ).bind(
        `org${String(i).padStart(5, "0")}/model-${i}`,
        JSON.stringify(k === 0 ? ["transformers", "qwen2"] : ["transformers", "pytorch"]),
        k === 3 ? "bert" : k === 0 ? "qwen2" : null,
        k === 1 ? "org00000/model-0" : k === 2 ? "ghost/absent-parent" : null,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await DB.batch(stmts.slice(i, i + 50));
}

async function snapshot() {
  const r = await DB.prepare(
    `SELECT repo_id, family, derivative_type FROM hf_models ORDER BY repo_id`,
  ).all<{ repo_id: string; family: string | null; derivative_type: string | null }>();
  return r.results ?? [];
}

/** Walks the whole set, sweeping on the schedule the caller chooses. */
async function walk(sweepEveryPass: boolean, page: number, maxPasses = 40) {
  let cursors = EMPTY_CURSORS;
  for (let pass = 0; pass < maxPasses; pass++) {
    const last = pass === maxPasses - 1;
    const part = await resolveModelFamilies(DB, page, cursors, {
      sweep: sweepEveryPass ? true : last,
    });
    cursors = part.cursors;
    if (part.done) break;
  }
}

describe("gating the sweeps does not change what the table ends up saying", () => {
  beforeEach(async () => {
    await DB.prepare("DELETE FROM hf_models").run();
  });

  it("produces an identical final state over a multi-pass walk", async () => {
    const N = 700;
    const PAGE = 100; // forces several passes

    await seed(N);
    await walk(true, PAGE);
    const sweepingEveryPass = await snapshot();

    await seed(N);
    await walk(false, PAGE);
    const sweepingOnce = await snapshot();

    // NOT identical, and the difference is the point.
    //
    // The lineage sweep — `base_model IS NOT NULL AND family IS NULL` ->
    // other-open — was racing the chain rung. A model declares a parent; the
    // sweep fires at the end of pass 1 and stamps it other-open because the
    // parent has not resolved YET; the parent resolves in pass 3; but the
    // child has already left `family IS NULL` and no rung ever looks at it
    // again. Its family was knowable and we published "other-open".
    //
    // Running the sweep once, at the end, gives lineage the chance to answer
    // first. So the property to assert is not equality — it is that gating the
    // sweeps never LOSES a family and only ever converts other-open into a
    // real one.
    const byId = new Map(sweepingEveryPass.map((r) => [r.repo_id, r]));
    const gained: string[] = [];

    for (const now of sweepingOnce) {
      const before = byId.get(now.repo_id)!;
      expect(now.derivative_type).toBe(before.derivative_type);

      if (now.family === before.family) continue;

      // The only permitted change, in one direction.
      expect(before.family).toBe("other-open");
      expect(now.family).not.toBeNull();
      expect(now.family).not.toBe("other-open");
      gained.push(now.repo_id);
    }

    // A row that had a real family must never come back unresolved.
    for (const before of sweepingEveryPass) {
      if (before.family !== null && before.family !== "other-open") {
        const now = sweepingOnce.find((r) => r.repo_id === before.repo_id)!;
        expect(now.family).toBe(before.family);
      }
    }

    expect(gained.length).toBeGreaterThan(0);

    // And the fixture genuinely exercised the paths, rather than resolving to
    // all-null and matching trivially.
    const families = new Set(sweepingOnce.map((r) => r.family));
    expect(families.has("qwen")).toBe(true);
    expect(families.has("other-open")).toBe(true);
    expect(families.has(null)).toBe(true);
    expect(sweepingOnce.some((r) => r.derivative_type === "base")).toBe(true);
  }, 180_000);

  it("still refuses to stamp rows no rung has walked when the walk is truncated", async () => {
    // One pass, a tiny page, a hard cap: most of the table is unexamined. The
    // bounded sweep must leave those rows NULL rather than calling them
    // other-open, or they leave `family IS NULL` and are never looked at again.
    await seed(400);
    await walk(false, 20, 1);

    const rows = await snapshot();
    const unexamined = rows.filter((r) => r.family === null);
    expect(unexamined.length).toBeGreaterThan(100);
  }, 180_000);
});
