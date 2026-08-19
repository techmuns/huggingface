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
  byName: number;
  /** Repos with no declared parent, labelled `base`. */
  byBase: number;
  total: number;
}

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

async function resolveFromTags(db: D1Database): Promise<number> {
  const rows = await db
    .prepare("SELECT repo_id, tags FROM hf_models WHERE family IS NULL")
    .all<{ repo_id: string; tags: string }>();

  if (!rows.results?.length) return 0;

  const stmts: D1PreparedStatement[] = [];
  let resolved = 0;

  for (const row of rows.results) {
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

  await batchExec(db, stmts);
  return resolved;
}

async function resolveFromCardData(db: D1Database): Promise<number> {
  const rows = await db
    .prepare(
      // Reads the column captured at parse time rather than re-joining the
      // raw payloads, which is what allows raw model records to be skipped.
      `SELECT repo_id, card_base_model AS cd_base
       FROM hf_models
       WHERE base_model IS NULL AND family IS NULL
         AND card_base_model IS NOT NULL`,
    )
    .all<{ repo_id: string; cd_base: string }>();

  if (!rows.results?.length) return 0;

  const stmts: D1PreparedStatement[] = [];
  let resolved = 0;

  for (const row of rows.results) {
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

  await batchExec(db, stmts);
  return resolved;
}

async function resolveByChain(db: D1Database): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < 10; pass++) {
    const rows = await db
      .prepare(
        `SELECT m.repo_id, parent.family
         FROM hf_models m
         JOIN hf_models parent ON m.base_model = parent.repo_id
         WHERE m.family IS NULL
           AND m.base_model IS NOT NULL
           AND parent.family IS NOT NULL`,
      )
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

async function resolveByNamePattern(db: D1Database): Promise<number> {
  const rows = await db
    .prepare("SELECT repo_id FROM hf_models WHERE family IS NULL AND base_model IS NULL")
    .all<{ repo_id: string }>();

  if (!rows.results?.length) return 0;

  const stmts: D1PreparedStatement[] = [];

  for (const row of rows.results) {
    const family = matchFamilyByName(row.repo_id);
    if (!family) continue;
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

  return batchExec(db, stmts);
}

export async function resolveModelFamilies(db: D1Database): Promise<ResolveSummary> {
  const byTag = await resolveFromTags(db);
  const byCardData = await resolveFromCardData(db);
  const byChain = await resolveByChain(db);
  const byName = await resolveByNamePattern(db);

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

  const total = byTag + byCardData + byChain + byName;
  return { byTag, byCardData, byChain, byName, byBase: base.meta?.changes ?? 0, total };
}
