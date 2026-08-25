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
 *   3. the declared architecture             (config.model_type, or the tag
 *                                             the Hub derives from it)
 *   4. repo-name pattern match              (lowest confidence)
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
  byArchitecture: number;
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
  /**
   * The rungs that had NOT finished walking when this pass returned.
   *
   * `done: false` on its own says a run ran out of passes without saying what
   * it ran out of them on, which is the difference between a report someone
   * can act on and a flag nobody looks at.
   */
  unfinished: string[];
}

/** One cursor per resolver: they walk different filtered sets. */
export interface ResolveCursors {
  tags: string;
  cardData: string;
  architecture: string;
  name: string;
}

export const EMPTY_CURSORS: ResolveCursors = {
  tags: "", cardData: "", architecture: "", name: "",
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

/**
 * `\b` is the wrong boundary for a repo name.
 *
 * An underscore is a word character, so in `qwen3_asr_1.7b` the boundary
 * between "3" and "_" is between two word characters and `/\bqwen\d*\b/`
 * never matches — nor does it in `experiments_gemma-2-2b` or
 * `MIDI-LLM_Llama-3.2-1B`. Underscores are one of the two things people
 * separate repo names with, so this was not an edge case: it left 145 models
 * in 12,000 unresolved whose names say plainly what they are.
 *
 * The replacement asks for "not preceded by a letter or digit, not followed by
 * a letter", which treats `_`, `-`, `.` and `/` alike and still refuses to
 * match a family name buried inside a longer word.
 */
const NL = "(?<![a-z0-9])", NR = "(?![a-z])";
const named = (...alts: string[]) => new RegExp(alts.map(a => `${NL}${a}${NR}`).join("|"), "i");

const FAMILY_BY_NAME: ReadonlyArray<[RegExp, string]> = [
  [named("qwen\\d*", "qwq"), "qwen"],
  [named("llama", "llava"), "llama"],
  [named("deepseek"), "deepseek"],
  [named("gemma\\d*"), "gemma"],
  [named("mistral", "mixtral"), "mistral"],
  [new RegExp(`${NL}chatglm${NR}|${NL}glm-?\\d`, "i"), "glm-zhipu"],
  [named("moonshot", "kimi"), "kimi-moonshot"],
  [named("nemotron"), "nvidia-nemotron"],
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

/**
 * The family a DECLARED PARENT belongs to.
 *
 * The org prefix is the reliable signal — `Qwen/Qwen3-8B` is a Qwen — but most
 * declared parents are not published by the org that made the family. The
 * ecosystem re-hosts through `unsloth/`, `bartowski/`, `mradermacher/` and
 * dozens of others, and every one of those was dropped on the floor for having
 * the wrong prefix: 664 models in 12,000, `unsloth` alone accounting for 298.
 *
 * Falling back to the parent's NAME is safe in a way that name-matching a
 * repo's own id is not. The string being read is a repo the author pointed at
 * as their parent, not a title they chose for themselves. Measured over the
 * same 12,000: where both rules fire, they agree 1,058 times and contradict
 * each other 0 times.
 */
export function matchFamilyOfParent(target: string): string | null {
  return matchFamily(target) ?? matchFamilyByName(target);
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
/**
 * Rows per D1 round trip inside one resolver pass.
 *
 * Each sub-chunk is one uninterrupted synchronous block — the await between
 * them is what ends the run of computation a step's 10 ms CPU budget measures
 * — so this, not RESOLVE_PAGE, is the number that decides whether a pass fits.
 *
 * It was 500, and 500 is what `resolve-models-14` died on: the architecture
 * rung's scan cost 6-7 ms in-loop at 40 tags a row and 17 ms at 80, because a
 * pass can land wholly inside one author's block of unplaceable records. The
 * scan itself is now ~3x cheaper, which is the real fix; halving the chunk is
 * the backstop, so the worst page the Hub can produce still has room.
 *
 * It costs only wall clock: sub-chunks loop inside ONE step, so twice as many
 * of them is twice the D1 round trips and not one extra step against the
 * 1,024-step instance limit.
 */
export const RESOLVE_SUBCHUNK = 250;

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
    const page = Math.min(RESOLVE_SUBCHUNK, limit - seen);
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

    const family = matchFamilyOfParent(info.target);
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

    // resolution_source is stamped only when a family was actually resolved.
    // It used to be written unconditionally alongside a NULL family, so a row
    // that went on to be marked `other-open` carried a provenance it never
    // earned — a claim about how we know something we did not know.
    const family = matchFamilyOfParent(target);
    stmts.push(
      family
        ? db
            .prepare(
              `UPDATE hf_models
                 SET base_model = ?1, derivative_type = 'finetune',
                     family = ?2, resolution_source = 'card_data'
               WHERE repo_id = ?3`,
            )
            .bind(target, family, row.repo_id)
        : db
            .prepare(
              `UPDATE hf_models
                 SET base_model = ?1, derivative_type = 'finetune'
               WHERE repo_id = ?2`,
            )
            .bind(target, row.repo_id),
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
 * Architecture -> family.
 *
 * The Hub reports what the model says it is: "llama", "qwen3_5_moe",
 * "gemma3", "chatglm". Prefix-anchored so a family name never matches inside
 * an unrelated architecture, and so the many bespoke model_types the Hub
 * carries ("inkling_mm_model", "Gr00tN1d7") fall through rather than being
 * forced into a bucket.
 */
/**
 * Architecture prefix -> family. Every entry is a PREFIX match, anchored and
 * case-insensitive, exactly as the eight separate regexes it replaces were.
 */
const FAMILY_BY_PREFIX: ReadonlyMap<string, string> = new Map([
  ["qwen", "qwen"],
  ["llama", "llama"],
  ["deepseek", "deepseek"],
  ["gemma", "gemma"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  ["glm", "glm-zhipu"],
  ["chatglm", "glm-zhipu"],
  ["kimi", "kimi-moonshot"],
  ["moonshot", "kimi-moonshot"],
  ["nemotron", "nvidia-nemotron"],
]);

/**
 * The same eight rules as ONE anchored alternation.
 *
 * This was eight separate `re.test()` calls in a loop, and it is the hottest
 * code in the pipeline: `matchFamilyByArchitecture` returns on the first tag
 * that matches, so a model it can place is cheap and a model it CANNOT pay the
 * full scan — roughly 30 tags x 8 regexes, ~240 regex executions, for every
 * unplaceable row. The rung is most expensive exactly where it achieves least.
 *
 * That is what killed `resolve-models-14` on 2026-08-24: a run reaches one
 * author's block of near-identical, fat-tagged, `model_type`-less records —
 * repo_id is "author/name" and every rung walks ORDER BY repo_id, so a pass
 * sits inside one or two authors — and the whole 500-row sub-chunk is
 * unplaceable at once. Measured in workerd inside the real loop: 6-7 ms at 40
 * tags a row, 15 ms at 60, 17 ms at 80, against a 10 ms step budget.
 */
const FAMILY_ARCH_RE =
  /^(qwen|llama|deepseek|gemma|mistral|mixtral|chatglm|glm|kimi|moonshot|nemotron)/i;

/**
 * First characters that can begin a family prefix, as lower-case char codes.
 *
 * Checked before `toLowerCase()` so the common case — a tag that cannot match
 * anything — costs one char-code compare and allocates nothing. `| 0x20`
 * lower-cases an ASCII letter; anything else lands on a code the set does not
 * hold, or falls through to the regex, which rejects it correctly either way.
 */
const FAMILY_FIRST_CHARS: ReadonlySet<number> = new Set(
  ["q", "l", "d", "g", "m", "c", "k", "n"].map((c) => c.charCodeAt(0)),
);

export function matchFamilyByModelType(modelType: string | null): string | null {
  if (!modelType) return null;
  if (!FAMILY_FIRST_CHARS.has(modelType.charCodeAt(0) | 0x20)) return null;
  const hit = FAMILY_ARCH_RE.exec(modelType);
  if (!hit) return null;
  // Only allocates on a match, which is the rare branch.
  return FAMILY_BY_PREFIX.get(hit[1]!.toLowerCase()) ?? null;
}

/**
 * Tags that read like an architecture and are a build tool.
 *
 * `llama.cpp` on a SmolLM2 GGUF says which converter produced the file, not
 * what the model is; `mistral-common` is a tokeniser library that rides along
 * on models from every family. 74 models in 12,000 carry one of these and
 * would otherwise be filed under a family they have nothing to do with.
 *
 * Treat this list as permanently incomplete. It is a blocklist over an open
 * vocabulary that anyone can add to, so it will always be one release behind;
 * that is a reason to keep it, not a reason to trust it alone.
 */
const TOOLING_TAGS: ReadonlySet<string> = new Set([
  "llama.cpp", "llama-cpp", "llamacpp", "llama_cpp", "llamacpp server",
  "llamafile", "llama-factory", "llamafactory", "llama_index", "llamaindex",
  "mistral-common", "mistral_common", "mistral-inference", "qwen-agent",
]);

/**
 * Stacks where an LLM architecture in the config is the TEXT ENCODER.
 *
 * A diffusion pipeline embeds a language model to read the prompt, and the
 * Hub reports that encoder's architecture as the repo's. `StableDiffusion-1.4-
 * Pruned-openvino` tagged `qwen3` is the clearest case: the tag is true of a
 * component and false of the model.
 *
 * Deliberately narrow. An earlier draft gated every non-language modality,
 * which also threw out Qwen's own ASR, TTS and image models — 30 rows in
 * 12,000 that genuinely are the family their architecture names. A speech
 * model fine-tuned from Gemma IS a developer building on Gemma, and the
 * question this cut answers is which families people build on.
 */
const DIFFUSION_STACK: ReadonlySet<string> = new Set([
  "diffusers", "comfyui", "pruna-ai", "open_clip", "k-diffusion",
]);
const GENERATIVE_PIPELINES: ReadonlySet<string> = new Set([
  "text-to-image", "image-to-image", "text-to-video", "image-to-video",
  "unconditional-image-generation", "text-to-3d", "image-to-3d",
]);

/** True when the architecture is describing a component, not the model. */
export function isTextEncoderOnly(
  repoId: string,
  family: string,
  pipelineTag: string | null,
  libraryName: string | null,
): boolean {
  const stack = DIFFUSION_STACK.has((libraryName ?? "").toLowerCase())
    || GENERATIVE_PIPELINES.has((pipelineTag ?? "").toLowerCase());
  // The repo's own name is the tie-breaker: `Qwen-Image` is a Qwen model that
  // makes images, `StableDiffusion-1.4-Pruned` is not.
  return stack && matchFamilyByName(repoId) !== family;
}

/**
 * The architecture family, from `config.model_type` or from the tag the Hub
 * derives from it.
 *
 * Both are read because the two sources are not interchangeable over time:
 * `model_type` is only present on records ingested while `config` was being
 * expanded, and the tag is present on all of them. Measured over 12,000
 * models: `model_type` appears verbatim as a tag in 4,786 of 4,786 cases, and
 * there is not one model the config can place that the tags cannot.
 */
export function matchFamilyByArchitecture(
  modelType: string | null,
  tags: readonly string[],
): string | null {
  const fromConfig = matchFamilyByModelType(modelType);
  if (fromConfig) return fromConfig;
  for (const tag of tags) {
    if (typeof tag !== "string" || tag.length === 0) continue;
    // The first-character gate comes before everything else that costs
    // anything. A real model carries ~30 tags and almost none of them can
    // begin a family prefix, so this is the branch that runs 30 times a row.
    if (!FAMILY_FIRST_CHARS.has(tag.charCodeAt(0) | 0x20)) continue;
    // Namespaced tags (`base_model:`, `license:`, `dataset:`, `arxiv:`) are
    // metadata, not architectures, and some of them contain family names.
    if (tag.includes(":")) continue;
    const lower = tag.toLowerCase();
    if (TOOLING_TAGS.has(lower)) continue;
    const family = matchFamilyByModelType(lower);
    if (family) return family;
  }
  return null;
}

interface ArchRow {
  repo_id: string;
  model_type: string | null;
  tags: string;
  pipeline_tag: string | null;
  library_name: string | null;
}

async function resolveByArchitecture(
  db: D1Database,
  limit: number,
  startCursor: string,
): Promise<{ resolved: number; cursor: string; exhausted: boolean }> {
  const { resolved, cursor, exhausted } = await paginateUnresolved<ArchRow>(
    db,
    // No `base_model IS NULL` guard. A model that declares a parent we could
    // not place is not a model whose own architecture is unknowable, and
    // withholding this rung from it is what put 243 models in 12,000 into
    // `other-open` while the config sitting in the same row named the family.
    //
    // This rung must run AFTER the lineage rungs, and that ordering is the
    // safety mechanism rather than a preference: a declared parent outranks a
    // declared architecture whenever the two disagree, which they do for 0.64%
    // of models — speculative-decoding drafters, mostly, where a Nemotron or a
    // Kimi is built on a Llama or a Qwen skeleton. Running architecture first
    // labels those by their skeleton. Running it second never sees them,
    // because `family IS NULL` is already false.
    (c, l) =>
      `SELECT repo_id, model_type, tags, pipeline_tag, library_name
       FROM hf_models
       WHERE family IS NULL AND repo_id > ${c}
       ORDER BY repo_id LIMIT ${l}`,
    limit,
    startCursor,
    (batch) => {
      const stmts: D1PreparedStatement[] = [];
      let resolved = 0;
      for (const row of batch) {
        let tags: string[] = [];
        try {
          const parsed: unknown = JSON.parse(row.tags);
          if (Array.isArray(parsed)) tags = parsed as string[];
        } catch {
          // A malformed tags column is a parse-time problem, not a reason to
          // abandon the whole page; the config path can still answer.
        }
        const family = matchFamilyByArchitecture(row.model_type, tags);
        if (!family) continue;
        if (isTextEncoderOnly(row.repo_id, family, row.pipeline_tag, row.library_name)) continue;
        resolved++;
        // resolution_source is left NULL rather than set to 'architecture'.
        // The CHECK on that column does not permit the value, and widening it
        // means rebuilding a ~75,000-row table to constrain something written
        // in five places and read in none — no metric, endpoint or dashboard
        // element queries it. NULL is the honest record here: the family is
        // known, its provenance is simply not in the current vocabulary. Give
        // the column a reader first, then widen the CHECK deliberately.
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

export interface ResolveOptions {
  /**
   * Whether to run the three end-of-pass sweeps, even if the rungs have not
   * finished walking.
   *
   * The sweeps only ever matter to the FINAL state, and they are the most
   * expensive thing in this file when repeated. Measured against real D1:
   * 17,522 rows read for the lineage sweep and 19,921 for the derivative-type
   * sweep, both writing zero rows on every pass after the first, times ~19
   * passes — about 3.2 million rows read a run to change nothing.
   *
   * So they are skipped until the last pass. `done` is the normal trigger; the
   * caller sets this when the loop is ending for the other reason — its pass
   * cap — because a truncated walk still has to leave the table in a coherent
   * state rather than mid-sweep.
   */
  sweep?: boolean;
}

export async function resolveModelFamilies(
  db: D1Database,
  limit: number = RESOLVE_PAGE,
  cursors: ResolveCursors = EMPTY_CURSORS,
  options: ResolveOptions = {},
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
  // base_model, and it must run here rather than earlier for exactly that
  // reason — see the note on its SELECT.
  const architecture = await resolveByArchitecture(db, limit, cursors.architecture);
  const name = await resolveByNamePattern(db, limit, cursors.name);

  const byTag = tags.resolved;
  const byCardData = cardData.resolved;
  const byArchitecture = architecture.resolved;
  const byName = name.resolved;

  // Done means every cursor-walking rung reached the end of its own set —
  // NOT that this pass happened to resolve nothing. Those differ precisely
  // when it matters: a pass landing entirely on unmatchable rows resolves
  // zero while a great deal is still unexamined behind it.
  const done = tags.exhausted && cardData.exhausted
    && architecture.exhausted && name.exhausted;

  // The sweeps below settle the FINAL state, and repeating them is pure cost:
  // measured against real D1 they read ~37,000 rows a pass and write nothing
  // after the first, ~19 passes a run. So they run once — when the walk is
  // finished, or when the caller says the loop is ending anyway.
  const shouldSweep = done || options.sweep === true;
  let baseChanges = 0;

  if (shouldSweep) {
    // Anything with a declared lineage that still couldn't be placed.
    //
    // This used to run at the end of EVERY pass, and the comment here said it
    // was safe to because `base_model` is only written by the lineage rungs,
    // so a row carrying one has already been through them. That reasoning has
    // a hole: the row has been through them, but its PARENT may not have been
    // resolved yet. A model declares a parent in pass 1, the sweep stamps it
    // `other-open` because the parent is still NULL, the parent resolves in
    // pass 3 — and the child has already left `family IS NULL`, so no rung
    // ever reconsiders it. Its family was knowable and we published the bucket
    // that means "we could not tell".
    //
    // Measured on a 700-model fixture: 100 rows recovered a real family once
    // this stopped running before the chain rung had finished. That is the
    // load-bearing reason it now runs once, at the end; the ~3 million rows a
    // run it stops reading is the lesser half.
    await db
      .prepare(
        `UPDATE hf_models SET family = 'other-open'
         WHERE base_model IS NOT NULL AND family IS NULL`,
      )
      .run();

    // And anything that told us its architecture plainly, where the architecture
    // is not one of the eight named families.
    //
    // This is the difference between "we could not tell what this is" and "this
    // is a BERT". 1,107 models in 12,000 — bert 424, roberta 76, xlm-roberta 66,
    // gpt2 62, distilbert 59, whisper 36, t5 28 — were being published as
    // Unresolved while the row said exactly what they were. The taxonomy is the
    // stakeholder's and is not ours to extend, but it already has the bucket for
    // this: `other-open` is "Other open models", and an open model that is none
    // of the eight named families is precisely that. A NULL family should mean
    // the one thing it cannot mean today — that we could not tell.
    //
    // Bounded, unlike the clause above, because `model_type` is written at PARSE
    // time: a row can carry one without any rung having looked at it. Stamping
    // those would take them out of `family IS NULL` and no later pass would ever
    // examine them — the exact failure the cursors exist to prevent. So it
    // reaches only as far as BOTH remaining rungs have walked, or the whole
    // table once both have walked it all.
    const walkedBoth = architecture.exhausted && name.exhausted
      ? null
      : (architecture.cursor && name.cursor
          ? (architecture.cursor < name.cursor ? architecture.cursor : name.cursor)
          : "");
    if (walkedBoth === null) {
      await db
        .prepare(
          `UPDATE hf_models SET family = 'other-open'
           WHERE family IS NULL AND base_model IS NULL AND model_type IS NOT NULL`,
        )
        .run();
    } else if (walkedBoth !== "") {
      await db
        .prepare(
          `UPDATE hf_models SET family = 'other-open'
           WHERE family IS NULL AND base_model IS NULL AND model_type IS NOT NULL
             AND repo_id <= ?1`,
        )
        .bind(walkedBoth)
        .run();
    }

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
    baseChanges = base.meta?.changes ?? 0;
  }

  const total = byTag + byCardData + byChain + byArchitecture + byName;

  return {
    byTag, byCardData, byChain, byArchitecture, byName,
    byBase: baseChanges, total,
    // Which rungs finished, so a run that ran out of passes can say WHICH set
    // it was still walking rather than only that it did not finish.
    unfinished: [
      tags.exhausted ? null : "tags",
      cardData.exhausted ? null : "cardData",
      architecture.exhausted ? null : "architecture",
      name.exhausted ? null : "name",
    ].filter((x): x is string => x !== null),
    cursors: {
      tags: tags.cursor,
      cardData: cardData.cursor,
      architecture: architecture.cursor,
      name: name.cursor,
    },
    done,
  };
}
