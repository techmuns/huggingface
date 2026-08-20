/**
 * Model-family resolution — Phase 4.
 *
 * Collapses thousands of repo names into a small set of families (Qwen,
 * Llama, DeepSeek …) by following the base_model lineage chain rather
 * than pattern-matching the repo's own name.  Deterministic, zero tokens.
 *
 * Fallback order:
 *   1. base_model:<relation>:<target> tags  (highest confidence)
 *   2. cardData.base_model from the raw payload
 *   3. repo-name pattern match              (lowest confidence)
 *
 * After each extraction pass, chain-following inherits from already-resolved
 * parents so that a quantized fine-tune of a Llama is still a Llama.
 */
import { D1_BATCH } from "./raw-store";

export interface BaseModelInfo {
  target: string;
  relation: "quantization" | "finetune" | "adapter" | "merge";
}

export interface ResolveSummary {
  byTag: number;
  byCardData: number;
  byChain: number;
  byModelType: number;
  byName: number;
  /** Repos with no declared parent, labelled `base`. */
  byBase: number;
  total: number;
  /**
   * Where each resolver stopped, to be handed to the next pass.
   *
   * Not an optimisation — correctness. Most of these resolvers legitimately
   * leave rows unmatched, so a pass that restarts at the head re-reads the
   * same unmatchable rows forever and never reaches what lies behind them.
   */
  cursors: ResolveCursors;
  /** True once every resolver has walked its whole set. */
  done: boolean;
}

/** One cursor per resolver: they walk different filtered sets. */
export interface ResolveCursors {
  tags: string;
  cardData: string;
  modelType: string;
  name: string;
}

export const EMPTY_CURSORS: ResolveCursors = {
  tags: "", cardData: "", modelType: "", name: "",
};

// ── Tag parsing ──────────────────────────────────────────────────────────────

const RELATION_PREFIXES: ReadonlyArray<{
  prefix: string;
  relation: BaseModelInfo["relation"];
}> = [
  { prefix: "base_model:quantized:", relation: "quantization" },
  { prefix: "base_model:adapter:", relation: "adapter" },
  { prefix: "base_model:merge:", relation: "merge" },
  { prefix: "base_model:finetune:", relation: "finetune" },
];

export function extractBaseModelInfo(tags: string[]): BaseModelInfo | null {
  for (const { prefix, relation } of RELATION_PREFIXES) {
    for (const tag of tags) {
      if (tag.startsWith(prefix)) {
        return { target: tag.slice(prefix.length), relation };
      }
    }
  }
  for (const tag of tags) {
    if (!tag.startsWith("base_model:")) continue;
    if (RELATION_PREFIXES.some((r) => tag.startsWith(r.prefix))) continue;
    const target = tag.slice(11);
    if (target) return { target, relation: "finetune" };
  }
  return null;
}

// ── Family pattern matching ──────────────────────────────────────────────────

const FAMILY_BY_ORG: ReadonlyArray<[RegExp, string]> = [
  [/^Qwen\//i, "qwen"],
  [/^meta-llama\//i, "llama"],
  [/^deepseek-ai\//i, "deepseek"],
  [/^google\/gemma/i, "gemma"],
  [/^mistralai\//i, "mistral"],
  [/^THUDM\//i, "glm-zhipu"],
  [/^moonshotai\//i, "kimi-moonshot"],
  [/^nvidia\/[Nn]emotron/i, "nvidia-nemotron"],
];

const FAMILY_BY_NAME: ReadonlyArray<[RegExp, string]> = [
  [/\bqwen\d*\b|\bqwq\b/i, "qwen"],
  [/\bllama\b|\bllava\b/i, "llama"],
  [/\bdeepseek\b/i, "deepseek"],
  [/\bgemma\b/i, "gemma"],
  [/\bmistral\b|\bmixtral\b/i, "mistral"],
  [/\bchatglm\b|\bglm-?\d/i, "glm-zhipu"],
  [/\bmoonshot\b|\bkimi\b/i, "kimi-moonshot"],
  [/\bnemotron\b/i, "nvidia-nemotron"],
];

export function matchFamily(target: string): string | null {
  for (const [re, family] of FAMILY_BY_ORG) {
    if (re.test(target)) return family;
  }
  return null;
}

export function matchFamilyByName(repoId: string): string | null {
  for (const [re, family] of FAMILY_BY_NAME) {
    if (re.test(repoId)) return family;
  }
  return null;
}

// ── Resolution pipeline ──────────────────────────────────────────────────────

const UPDATE_BATCH = D1_BATCH;

async function batchExec(db: D1Database, stmts: D1PreparedStatement[]): Promise<number> {
  if (stmts.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < stmts.length; i += UPDATE_BATCH) {
    const results = await db.batch(stmts.slice(i, i + UPDATE_BATCH));
    total += results.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
  }
  return total;
}

/**
 * Rows a single resolver pass will look at.
 *
 * The resolvers used to select their whole working set — every model with no
 * family — and build one prepared statement per row. At 77,632 models with
 * roughly half unresolved that is 40,000 rows and 40,000 statement objects in
 * one Worker invocation, and the run died with "Worker exceeded CPU time
 * limit". resolveByChain was worse: it did that ten times in a loop.
 *
 * So a pass is bounded. The bound has to come with a cursor rather than a bare
 * LIMIT, because most of these resolvers legitimately leave rows unmatched — a
 * repo whose name says nothing about its family is simply not resolvable — and
 * a LIMIT alone would re-select those same unmatched rows on every pass and
 * never advance.
 */
export const RESOLVE_PAGE = 2_000;

/**
 * Walks `family IS NULL` rows in repo_id order, bounded, resolving as it goes.
 *
 * `build` returns the statements for one page and how many of them actually
 * resolved a family; rows it declines to act on are still passed over, because
 * the cursor advances on rows SEEN rather than rows changed.
 *
 * The starting cursor comes from the CALLER and the ending one is returned.
 * An earlier version began every call at "" and threw the ending cursor away,
 * which quietly undid the whole point: each pass re-read the head of the set,
 * advanced only by however many rows it happened to resolve, and the workflow
 * stopped as soon as one pass resolved nothing. Everything past the first
 * unmatchable stretch was never examined, and `COALESCE(family, 'unknown')`
 * published it as "unknown" — indistinguishable from a row that was checked
 * and could not be placed.
 */
async function paginateUnresolved<T extends { repo_id: string }>(
  db: D1Database,
  sql: (cursorParam: string, limitParam: string) => string,
  limit: number,
  startCursor: string,
  build: (rows: T[]) => { stmts: D1PreparedStatement[]; resolved: number },
): Promise<{ resolved: number; seen: number; cursor: string; exhausted: boolean }> {
  let cursor = startCursor;
  let resolved = 0;
  let seen = 0;
  let exhausted = false;

  while (seen < limit) {
    const page = Math.min(500, limit - seen);
    const rows = await db
      .prepare(sql("?1", "?2"))
      .bind(cursor, page)
      .all<T>();

    const batch = rows.results ?? [];
    if (batch.length === 0) { exhausted = true; break; }

    seen += batch.length;
    // Non-null by construction: batch.length > 0 was checked above.
    cursor = batch[batch.length - 1]!.repo_id;

    const { stmts, resolved: n } = build(batch);
    if (stmts.length > 0) await batchExec(db, stmts);
    resolved += n;

    if (batch.length < page) { exhausted = true; break; }
  }

  return { resolved, seen, cursor, exhausted };
}

async function resolveFromTags(
  db: D1Database,
  limit: number,
  startCursor: string,
): Promise<{ resolved: number; cursor: string; exhausted: boolean }> {
  const { resolved, cursor, exhausted } = await paginateUnresolved<{ repo_id: string; tags: string }>(
    db,
    (c, l) =>
      `SELECT repo_id, tags FROM hf_models
       WHERE family IS NULL AND repo_id > ${c}
       ORDER BY repo_id LIMIT ${l}`,
    limit,
    startCursor,
    (batch) => {
  const stmts: D1PreparedStatement[] = [];
  let resolved = 0;

  for (const row of batch) {
    const tags: string[] = JSON.parse(row.tags);
    const info = extractBaseModelInfo(tags);
    if (!info) continue;

    const family = matchFamily(info.target);
    if (family) {
      stmts.push(
        db
          .prepare(
            `UPDATE hf_models
               SET base_model = ?1, derivative_type = ?2, family = ?3,
                   resolution_source = 'base_model_tag'
             WHERE repo_id = ?4`,
          )
          .bind(info.target, info.relation, family, row.repo_id),
      );
      resolved++;
    } else {
      stmts.push(
        db
          .prepare(
            `UPDATE hf_models
               SET base_model = ?1, derivative_type = ?2
             WHERE repo_id = ?3`,
          )
          .bind(info.target, info.relation, row.repo_id),
      );
    }
  }

  return { stmts, resolved };
    },
  );
  return { resolved, cursor, exhausted };
}

async function resolveFromCardData(
  db: D1Database,
  limit: number,
  startCursor: string,
): Promise<{ resolved: number; cursor: string; exhausted: boolean }> {
  const { resolved, cursor, exhausted } = await paginateUnresolved<{ repo_id: string; cd_base: string }>(
    db,
    // Reads the column captured at parse time rather than re-joining the raw
    // payloads, which is what allows raw model records to be skipped.
    (c, l) =>
      `SELECT repo_id, card_base_model AS cd_base
       FROM hf_models
       WHERE base_model IS NULL AND family IS NULL
         AND card_base_model IS NOT NULL AND repo_id > ${c}
       ORDER BY repo_id LIMIT ${l}`,
    limit,
    startCursor,
    (batch) => {
  const stmts: D1PreparedStatement[] = [];
  let resolved = 0;

  for (const row of batch) {
    let target: string | null = null;
    try {
      const parsed = JSON.parse(row.cd_base);
      target = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      target = row.cd_base;
    }
    if (typeof target !== "string" || !target) continue;

    const family = matchFamily(target);
    stmts.push(
      db
        .prepare(
          `UPDATE hf_models
             SET base_model = ?1, derivative_type = 'finetune',
                 family = ?2, resolution_source = 'card_data'
           WHERE repo_id = ?3`,
        )
        .bind(target, family, row.repo_id),
    );
    if (family) resolved++;
  }

  return { stmts, resolved };
    },
  );
  return { resolved, cursor, exhausted };
}

async function resolveByChain(db: D1Database, limit: number): Promise<number> {
  let total = 0;
  // Every selected row IS resolved here — the join requires the parent to have
  // a family — so this one cannot stall on unmatched rows and a plain bound is
  // enough. The old code ran ten unbounded passes; the bound is what matters.
  for (let pass = 0; pass < 10; pass++) {
    const rows = await db
      .prepare(
        `SELECT m.repo_id, parent.family
         FROM hf_models m
         JOIN hf_models parent ON m.base_model = parent.repo_id
         WHERE m.family IS NULL
           AND m.base_model IS NOT NULL
           AND parent.family IS NOT NULL
         LIMIT ?1`,
      )
      .bind(limit)
      .all<{ repo_id: string; family: string }>();

    if (!rows.results?.length) break;

    const stmts = rows.results.map((r) =>
      db
        .prepare(
          `UPDATE hf_models
             SET family = ?1, resolution_source = COALESCE(resolution_source, 'base_model_tag')
           WHERE repo_id = ?2`,
        )
        .bind(r.family, r.repo_id),
    );
    total += await batchExec(db, stmts);
  }
  return total;
}


/**
 * Architecture -> family, from config.model_type.
 *
 * The Hub reports what the model says it is: "llama", "qwen3_5_moe",
 * "gemma3", "chatglm". Prefix-anchored so a family name never matches inside
 * an unrelated architecture, and so the many bespoke model_types the Hub
 * carries ("inkling_mm_model", "Gr00tN1d7") fall through rather than being
 * forced into a bucket.
 */
const FAMILY_BY_MODEL_TYPE: ReadonlyArray<[RegExp, string]> = [
  [/^qwen/i, "qwen"],
  [/^llama/i, "llama"],
  [/^deepseek/i, "deepseek"],
  [/^gemma/i, "gemma"],
  [/^(?:mistral|mixtral)/i, "mistral"],
  [/^(?:glm|chatglm)/i, "glm-zhipu"],
  [/^(?:kimi|moonshot)/i, "kimi-moonshot"],
  [/^nemotron/i, "nvidia-nemotron"],
];

export function matchFamilyByModelType(modelType: string | null): string | null {
  if (!modelType) return null;
  for (const [re, family] of FAMILY_BY_MODEL_TYPE) {
    if (re.test(modelType)) return family;
  }
  return null;
}

async function resolveByModelType(
  db: D1Database,
  limit: number,
  startCursor: string,
): Promise<{ resolved: number; cursor: string; exhausted: boolean }> {
  const { resolved, cursor, exhausted } = await paginateUnresolved<{ repo_id: string; model_type: string }>(
    db,
    (c, l) =>
      `SELECT repo_id, model_type FROM hf_models
       WHERE family IS NULL AND base_model IS NULL AND model_type IS NOT NULL
         AND repo_id > ${c}
       ORDER BY repo_id LIMIT ${l}`,
    limit,
    startCursor,
    (batch) => {
  const stmts: D1PreparedStatement[] = [];
  let resolved = 0;
  for (const row of batch) {
    const family = matchFamilyByModelType(row.model_type);
    if (!family) continue;
    resolved++;
    // resolution_source is left NULL rather than set to 'config_model_type'.
    // The CHECK on that column does not permit the value, and widening it
    // means rebuilding a ~75,000-row table to constrain something written in
    // five places and read in none — no metric, endpoint or dashboard element
    // queries it. NULL is the honest record here: the family is known, its
    // provenance is simply not in the current vocabulary. Give the column a
    // reader first, then widen the CHECK deliberately.
    stmts.push(
      db
        .prepare(
          `UPDATE hf_models
             SET family = ?1, resolution_source = NULL
           WHERE repo_id = ?2`,
        )
        .bind(family, row.repo_id),
    );
  }
  return { stmts, resolved };
    },
  );
  return { resolved, cursor, exhausted };
}

async function resolveByNamePattern(
  db: D1Database,
  limit: number,
  startCursor: string,
): Promise<{ resolved: number; cursor: string; exhausted: boolean }> {
  const { resolved, cursor, exhausted } = await paginateUnresolved<{ repo_id: string }>(
    db,
    (c, l) =>
      `SELECT repo_id FROM hf_models
       WHERE family IS NULL AND base_model IS NULL AND repo_id > ${c}
       ORDER BY repo_id LIMIT ${l}`,
    limit,
    startCursor,
    (batch) => {
  const stmts: D1PreparedStatement[] = [];
  let resolved = 0;

  for (const row of batch) {
    const family = matchFamilyByName(row.repo_id);
    if (!family) continue;
    resolved++;
    stmts.push(
      db
        .prepare(
          `UPDATE hf_models
             SET family = ?1, resolution_source = 'name_pattern'
           WHERE repo_id = ?2`,
        )
        .bind(family, row.repo_id),
    );
  }

  return { stmts, resolved };
    },
  );
  return { resolved, cursor, exhausted };
}

export async function resolveModelFamilies(
  db: D1Database,
  limit: number = RESOLVE_PAGE,
  cursors: ResolveCursors = EMPTY_CURSORS,
): Promise<ResolveSummary> {
  const tags = await resolveFromTags(db, limit, cursors.tags);
  const cardData = await resolveFromCardData(db, limit, cursors.cardData);
  // The only rung with no cursor: its join requires the parent to already have
  // a family, so every row it selects is one it resolves. It cannot stall on
  // unmatchable rows, and it must re-run from the start each pass because rows
  // become eligible only once their parent is resolved.
  const byChain = await resolveByChain(db, limit);
  // Between a declared parent and a guess from the title: the model's own
  // declared architecture. Stronger than the name, weaker than a stated
  // base_model, and recorded as such.
  const modelType = await resolveByModelType(db, limit, cursors.modelType);
  const name = await resolveByNamePattern(db, limit, cursors.name);

  const byTag = tags.resolved;
  const byCardData = cardData.resolved;
  const byModelType = modelType.resolved;
  const byName = name.resolved;

  // Anything with a declared lineage that still couldn't be placed
  await db
    .prepare(
      `UPDATE hf_models SET family = 'other-open'
       WHERE base_model IS NOT NULL AND family IS NULL`,
    )
    .run();

  // A repo that declares no parent is a base model. The brief asks for all
  // six derivative types, and without this every repo without a base_model
  // tag would report a NULL type — indistinguishable from "not yet resolved"
  // and leaving the single largest bucket unlabelled.
  const base = await db
    .prepare(
      `UPDATE hf_models SET derivative_type = 'base'
       WHERE base_model IS NULL AND derivative_type IS NULL`,
    )
    .run();

  const total = byTag + byCardData + byChain + byModelType + byName;

  // Done means every cursor-walking rung reached the end of its own set —
  // NOT that this pass happened to resolve nothing. Those differ precisely
  // when it matters: a pass landing entirely on unmatchable rows resolves
  // zero while a great deal is still unexamined behind it.
  const done = tags.exhausted && cardData.exhausted
    && modelType.exhausted && name.exhausted;

  return {
    byTag, byCardData, byChain, byModelType, byName,
    byBase: base.meta?.changes ?? 0, total,
    cursors: {
      tags: tags.cursor,
      cardData: cardData.cursor,
      modelType: modelType.cursor,
      name: name.cursor,
    },
    done,
  };
}
