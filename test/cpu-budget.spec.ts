import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  RULES_PAGE_SIZE,
  classifyByRules,
  classifySpacesByRules,
  type SpaceSignals,
} from "../src/lib/classify-rules";
import { DEDUP_PAGE, README_MAX_BYTES, dedupSpaces, truncateToBytes } from "../src/lib/enrich";

/**
 * What a Workflow step gets on Workers Free, and what we design against.
 *
 * Cloudflare's rule is that an instance runs as long as no STEP exceeds its
 * CPU limit and the instance stays under 1,024 steps. So the thing worth
 * testing is the CPU of a step BODY at the page size the pipeline configures —
 * not the number of steps, which is plentiful.
 *
 * Every failure this suite exists for was a body over the ceiling:
 *
 *   classify-rules @400   39.6 ms   (18.6 ms of rules + 21.0 ms hashing)
 *   truncateToBytes x150  72.8 ms   (per-character loop over 32 KB READMEs)
 *   dedup, unpaged        10.0 ms at 7,000 Spaces, 43 ms at 20,000
 *
 * Each shipped green because nothing measured it. The budget below is half the
 * ceiling, and the assertion is deliberately looser than the budget so a
 * slower CI machine does not fail the build — it is a smoke alarm for a 4x
 * regression, not a stopwatch.
 */
const CEILING_MS = 10;
const DESIGN_BUDGET_MS = CEILING_MS / 2;
const ASSERT_MS = 8;

const DB = env.DB;

/** A README at the storage cap: the worst case the enrich queue really holds. */
const FAT_README =
  "# Demo\n\n" + "This space runs a qwen2.5 coder model for code completion. ".repeat(560);

function signals(i: number): SpaceSignals {
  return {
    spaceId: `user${i}/space-${i}`,
    title: `Demo Space ${i}`,
    shortDescription: "A chat assistant built on llama 3",
    sdk: "gradio",
    tags: ["text-generation", "chat", "llm", "transformers"],
    linkedModels: ["Qwen/Qwen2.5-Coder-7B"],
    linkedDatasets: [],
    readmeText: FAT_README,
  };
}

/** Runs `fn` `reps` times and returns the mean, after one warm-up pass. */
function perRun(fn: () => void, reps: number): number {
  fn();
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) fn();
  return (performance.now() - t0) / reps;
}

function report(label: string, ms: number): number {
  console.log(
    `  ${label}: ${ms.toFixed(2)} ms  (budget ${DESIGN_BUDGET_MS}, ceiling ${CEILING_MS})`,
  );
  return ms;
}

describe("step bodies fit inside a Workflow step's CPU", () => {
  it("classify-rules: a full page of Spaces with capped READMEs", () => {
    const page = Array.from({ length: RULES_PAGE_SIZE }, (_, i) => signals(i));
    const ms = report(
      `classify-rules page (${RULES_PAGE_SIZE} Spaces)`,
      perRun(() => {
        for (const s of page) classifyByRules(s);
      }, 20),
    );
    expect(ms).toBeLessThan(ASSERT_MS);
  });

  it("classify-rules reuses the stored README hash instead of recomputing one", async () => {
    // The step used to SHA-256 `JSON.stringify(signals)` — the whole 32 KB
    // README included — once per row, to fill `content_hash`, a column nothing
    // in src/ or migrations/ ever reads. That was 21 ms of the 39.6 ms page.
    //
    // Asserted through behaviour rather than by grepping the source: the row's
    // own `readme_hash` must come back out of `content_hash`. A reintroduced
    // per-row hash would write a different value and fail here.
    await DB.batch([
      DB.prepare("DELETE FROM hf_classifications"),
      DB.prepare("DELETE FROM hf_spaces"),
    ]);
    await DB.prepare(
      `INSERT INTO hf_spaces (space_id, author, title, sdk, created_at, last_modified,
                              likes, tags, linked_models, linked_datasets,
                              readme_text, readme_hash, first_seen_at, updated_at)
       VALUES ('u/coder', 'u', 'Code completion demo', 'gradio', '2026-08-17T00:00:00.000Z',
               '2026-08-17T00:00:00.000Z', 0, '["text-generation"]', '[]', '[]',
               ?1, 'sentinel-readme-hash', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    ).bind(FAT_README).run();

    const out = await classifySpacesByRules(DB, "2026-08-17", "2026-08-24");
    expect(out.classified).toBe(1);

    const stored = await DB.prepare(
      `SELECT content_hash FROM hf_classifications WHERE space_id = 'u/coder'`,
    ).first<{ content_hash: string | null }>();
    expect(stored?.content_hash).toBe("sentinel-readme-hash");
  });

  it("enrich: a batch of oversized READMEs truncates in budget", () => {
    const oversized = "a".repeat(200_000);
    const ms = report(
      "enrich truncate (150 oversized READMEs)",
      perRun(() => {
        for (let i = 0; i < 150; i++) truncateToBytes(oversized, README_MAX_BYTES);
      }, 10),
    );
    expect(ms).toBeLessThan(ASSERT_MS);
  });

  const dupGroup = (i: number) => (i % 7 === 0 ? Math.floor(i / 7) % 100 : null);

  it("dedup is paged, so its cost does not track the size of the week", async () => {
    // The bug this pins: dedup was the one stage with no page, no cursor and
    // no cap, so its CPU was a pure function of how big a week the Hub had.
    expect(DEDUP_PAGE).toBeLessThanOrEqual(1_000);

    // A week larger than any observed, and larger than one page, still lands.
    const WEEK = 3_500;
    await DB.prepare("DELETE FROM hf_spaces").run();
    const stmts = [];
    for (let i = 0; i < WEEK; i++) {
      stmts.push(
        DB.prepare(
          `INSERT INTO hf_spaces (space_id, author, title, sdk, created_at, last_modified,
                                  likes, tags, linked_models, linked_datasets, first_seen_at, updated_at)
           VALUES (?1, ?2, ?3, 'gradio', ?4, ?4, 0, '[]', ?5, '[]', ?4, ?4)`,
        ).bind(
          `user${String(i).padStart(6, "0")}/space-${i}`,
          `user${i}`,
          // Every 7th Space joins one of 100 duplicate groups of 5; the rest
          // are unique. Real weeks cluster ~300 groups out of ~6,600.
          dupGroup(i) === null ? `Space ${i} demo app` : `Duplicate demo ${dupGroup(i)}`,
          `2026-08-17T${String(i % 12).padStart(2, "0")}:00:00.000Z`,
          JSON.stringify([dupGroup(i) === null ? `org/model-${i % 700}` : `org/shared-${dupGroup(i)}`]),
        ),
      );
    }
    for (let i = 0; i < stmts.length; i += 50) await DB.batch(stmts.slice(i, i + 50));

    const out = await dedupSpaces(DB, "2026-08-17", "2026-08-24");
    expect(out.clusters).toBeGreaterThan(0);

    // Every Space ends up in exactly one cluster, primary or not — the
    // invariant every is_cluster_primary-filtered metric depends on.
    const unassigned = await DB.prepare(
      `SELECT COUNT(*) AS n FROM hf_spaces WHERE dedup_cluster_id IS NULL`,
    ).first<{ n: number }>();
    expect(unassigned?.n).toBe(0);

    const nulls = await DB.prepare(
      `SELECT COUNT(*) AS n FROM hf_spaces WHERE is_cluster_primary IS NULL`,
    ).first<{ n: number }>();
    expect(nulls?.n).toBe(0);
  }, 180_000);
});
