/**
 * Phase 8 — written insight, grounded so a figure cannot be invented.
 *
 * A model asked to summarise a week will write good prose and, sooner or
 * later, a number that is not in the data. Not often, and not obviously: it
 * rounds 1,462 to "roughly 1,500", it carries a share from the paragraph
 * above, it adds two figures that were never meant to be added. On a page
 * whose entire value is that its numbers are right, that is the one failure
 * mode there is no recovering from — a reader who catches one invented figure
 * has no reason to trust the other twelve.
 *
 * So the model is never given the opportunity. It receives a numbered pack of
 * facts and writes prose that refers to them by SLOT — `{{F17.value}}`,
 * `{{F17.change}}` — and the server substitutes the real figures afterwards.
 * The output is then checked to contain no digits of its own at all. A model
 * that writes "about 1,500" fails validation rather than reaching a reader.
 *
 * The second half of the design is which facts go in the pack. Every
 * eligibility rule is enforced by OMITTING the fact, never by instructing the
 * model to be careful with it. A prompt that says "do not report changes on a
 * denominator below thirty" is a request; a pack that does not contain the
 * fact is a guarantee. The week of 3 August 2026 is why this matters: its
 * classification coverage was 21.68% because the LLM classifier never ran
 * (`bySource: { rule: 1250, model: 0 }`), so every use-case and technique
 * figure for that week describes a quarter of it. Those facts do not enter the
 * pack at all, and one fact saying coverage was too low does.
 */

import { BedrockClient, type BedrockRequest, firstText } from "./bedrock";
import { TAXONOMY_VERSION } from "./taxonomy";

export const INSIGHT_PROMPT_VERSION = "insight-1";

/** Below this share of new Spaces classified, no classification fact is usable. */
export const MIN_COVERAGE = 40;
/** A percentage over fewer than this many Spaces is not a rate, it is a rumour. */
export const MIN_DENOMINATOR = 30;
/** How many categories of each cut are worth putting in front of a model. */
export const TOP_N = 6;

export type InsightKind = "week" | "month";

export interface Fact {
  id: string;
  /** What it is, in the words the prose should use. */
  what: string;
  unit: "count" | "percent";
  value: number;
  prev: number | null;
  /** Relative change, as a percentage of the previous figure. */
  changePct: number | null;
  /** Absolute change, in points. Only meaningful for a share. */
  changePts: number | null;
  denominator: number | null;
}

export interface FactPack {
  kind: InsightKind;
  periodKey: string;
  periodLabel: string;
  previousLabel: string | null;
  facts: Fact[];
  /** What was left out, and why. Recorded, not sent. */
  omitted: string[];
}

/* ── Pulling the numbers ─────────────────────────────────────────────────── */

interface MetricRow {
  metric_cut: string;
  dimension: string;
  sub_dimension: string;
  value: number;
  denominator: number;
  coverage: number | null;
  suppressed: number;
  week_start: string;
}

async function metricsForWeeks(db: D1Database, weeks: readonly string[]): Promise<MetricRow[]> {
  if (weeks.length === 0) return [];
  const holes = weeks.map((_, i) => `?${i + 2}`).join(", ");
  const res = await db
    .prepare(
      `SELECT week_start, metric_cut, dimension, sub_dimension, value, denominator,
              coverage, suppressed
         FROM hf_weekly_metrics
        WHERE taxonomy_version = ?1 AND week_start IN (${holes})`,
    )
    .bind(TAXONOMY_VERSION, ...weeks)
    .all<MetricRow>();
  return res.results ?? [];
}

/**
 * Counts add, percentages pool by their own bases, levels take the last week.
 *
 * The same three rules the dashboard combines periods by, so a figure in the
 * prose and the same figure on the chart cannot disagree. A flat mean of four
 * weekly shares is not a monthly share, and this is the one place where being
 * wrong about that would be invisible — it would read as a sentence.
 */
function combine(
  rows: readonly MetricRow[],
  weeks: readonly string[],
  kind: "count" | "percent" | "level",
): { value: number | null; denominator: number | null } {
  const order = new Map(weeks.map((w, i) => [w, i]));
  let sum: number | null = null, wnum = 0, wden = 0, den: number | null = null;
  let lastAt = -1, last: number | null = null, lastDen: number | null = null;
  for (const r of rows) {
    const at = order.get(r.week_start);
    if (at === undefined) continue;
    sum = (sum ?? 0) + r.value;
    if (r.denominator > 0) { wnum += r.value * r.denominator; wden += r.denominator; }
    den = (den ?? 0) + r.denominator;
    if (at > lastAt) { lastAt = at; last = r.value; lastDen = r.denominator; }
  }
  if (sum === null) return { value: null, denominator: null };
  if (kind === "percent") return { value: wden > 0 ? wnum / wden : null, denominator: wden || null };
  if (kind === "level") return { value: last, denominator: lastDen };
  return { value: sum, denominator: den };
}

/* ── Building the pack ───────────────────────────────────────────────────── */

const KIND_OF: Record<string, "count" | "percent" | "level"> = {
  spaces_by_use_case: "count",
  models_by_family: "count",
  sdk_distribution: "count",
  share_by_use_case: "percent",
  vertical_penetration: "percent",
  technology_penetration: "percent",
  engagement: "level",
};

/** Cuts that only mean anything if the week was actually classified. */
const NEEDS_COVERAGE = new Set([
  "spaces_by_use_case", "share_by_use_case", "vertical_penetration",
  "technology_penetration", "family_share_by_use_case",
]);

const WHAT: Record<string, (dim: string) => string> = {
  spaces_by_use_case: (d) => `new Spaces built for ${label(d)}`,
  models_by_family: (d) => `new models in the ${label(d)} family`,
  sdk_distribution: (d) => `new Spaces shipped with ${label(d)}`,
  vertical_penetration: (d) => `the share of new Spaces serving ${label(d)}`,
  technology_penetration: (d) => `the share of new Spaces using ${label(d)}`,
  engagement: (d) => `${label(d).toLowerCase()}`,
};

const NAMES: Record<string, string> = {
  qwen: "Qwen", llama: "Llama", deepseek: "DeepSeek", gemma: "Gemma", mistral: "Mistral",
  gradio: "Gradio", streamlit: "Streamlit", docker: "Docker", static: "Static",
  coding: "coding", education: "education", robotics: "robotics", finance: "finance",
  legal: "legal", healthcare: "healthcare", consumer: "consumer",
  cybersecurity: "cybersecurity", other: "everything else",
  "chat-assistant": "chat and assistants", "search-research": "search and research",
  "document-ai": "document AI", "data-analysis": "data analysis",
  "image-generation": "image generation", "video-generation": "video generation",
  "voice-audio": "voice and audio", "music-generation": "music generation",
  "3d-gaming": "3D and gaming", "scientific-tools": "scientific tools",
  "glm-zhipu": "GLM / Zhipu", "kimi-moonshot": "Kimi / Moonshot",
  "nvidia-nemotron": "NVIDIA Nemotron", "other-open": "other open models",
  "proprietary-api": "proprietary APIs", unknown: "unresolved",
  rag: "RAG", moe: "MoE", "tool-use": "tool use", "long-context": "long context",
  "vision-language": "vision-language", "local-inference": "local inference",
  "fine-tuned": "fine-tuned", "enterprise-productivity": "enterprise productivity",
  "media-entertainment": "media and entertainment", "ecommerce-retail": "e-commerce and retail",
  "industrial-manufacturing": "industrial and manufacturing",
  "scientific-research": "scientific research",
  model_downloads: "Model downloads", model_likes: "Model likes", space_likes: "Space likes",
};

function label(dim: string): string {
  return NAMES[dim] ?? dim.replace(/[-_]/g, " ");
}

export interface BuildPackOptions {
  kind: InsightKind;
  periodKey: string;
  periodLabel: string;
  previousLabel: string | null;
  /** The weeks in this period, and in the one before it. Both in order. */
  weeks: readonly string[];
  previousWeeks: readonly string[];
}

export async function buildFactPack(db: D1Database, opts: BuildPackOptions): Promise<FactPack> {
  const rows = await metricsForWeeks(db, [...opts.weeks, ...opts.previousWeeks]);
  const omitted: string[] = [];
  const facts: Fact[] = [];
  let n = 0;
  const add = (f: Omit<Fact, "id">): void => { facts.push({ id: `F${++n}`, ...f }); };

  const inNow = (r: MetricRow) => opts.weeks.includes(r.week_start);
  const inPrev = (r: MetricRow) => opts.previousWeeks.includes(r.week_start);

  if (rows.length === 0) {
    return { ...opts, facts: [], omitted: ["no metrics have been computed for this period"] };
  }

  /* Coverage first, because it decides what else is allowed in. */
  const covRows = rows.filter((r) => r.metric_cut === "spaces_by_use_case" && inNow(r));
  const coverage = covRows.length
    ? covRows.reduce((s, r) => s + (r.coverage ?? 0), 0) / covRows.length
    : null;
  const totalSpaces = covRows.reduce((s, r) => s + r.value, 0);
  const classifiable = coverage != null && coverage >= MIN_COVERAGE;

  add({
    what: "the share of new Spaces we were able to classify",
    unit: "percent",
    value: coverage ?? 0,
    prev: null, changePct: null, changePts: null,
    denominator: totalSpaces || null,
  });
  if (!classifiable) {
    omitted.push(
      `every classification-derived figure: coverage was ${
        coverage == null ? "not recorded" : coverage.toFixed(1) + "%"}, below the ${MIN_COVERAGE}% floor`,
    );
  }

  /* Headline counts. These come from hf_spaces directly and do not depend on
     anything having been classified, so they survive a coverage collapse. */
  for (const [cut, what] of [
    ["models_by_family", "new models"],
    ["sdk_distribution", "new Spaces"],
  ] as const) {
    const all = rows.filter((r) => r.metric_cut === cut);
    const now = combine(all.filter(inNow), opts.weeks, "count");
    const prev = combine(all.filter(inPrev), opts.previousWeeks, "count");
    if (now.value == null) continue;
    add({
      what: `${what} in total`,
      unit: "count",
      value: now.value,
      prev: prev.value,
      changePct: prev.value ? ((now.value - prev.value) / prev.value) * 100 : null,
      changePts: null,
      denominator: null,
    });
  }

  /* Each cut's biggest categories. */
  for (const cut of ["spaces_by_use_case", "models_by_family", "technology_penetration",
                     "vertical_penetration", "sdk_distribution", "engagement"] as const) {
    if (NEEDS_COVERAGE.has(cut) && !classifiable) continue;
    const kind = KIND_OF[cut] ?? "count";
    const all = rows.filter((r) => r.metric_cut === cut);
    const dims = [...new Set(all.map((r) => r.dimension))];

    const scored = dims.map((dim) => {
      const mine = all.filter((r) => r.dimension === dim);
      return { dim, now: combine(mine.filter(inNow), opts.weeks, kind),
               prev: combine(mine.filter(inPrev), opts.previousWeeks, kind),
               suppressed: mine.filter(inNow).every((r) => r.suppressed === 1) };
    }).filter((s) => s.now.value != null)
      .sort((a, b) => (b.now.value ?? 0) - (a.now.value ?? 0));

    for (const s of scored.slice(0, TOP_N)) {
      if (s.suppressed) {
        omitted.push(`${cut}/${s.dim}: the pipeline marked it too small to report`);
        continue;
      }
      if (kind === "percent" && (s.now.denominator ?? 0) < MIN_DENOMINATOR) {
        omitted.push(
          `${cut}/${s.dim}: a share over ${s.now.denominator ?? 0} Spaces, below the ${MIN_DENOMINATOR} floor`);
        continue;
      }
      const value = s.now.value as number;
      const prev = s.prev.value;
      add({
        what: (WHAT[cut] ?? ((d: string) => `${cut} ${label(d)}`))(s.dim),
        unit: kind === "percent" ? "percent" : "count",
        value,
        prev,
        changePct: prev ? ((value - prev) / prev) * 100 : null,
        changePts: kind === "percent" && prev != null ? value - prev : null,
        denominator: s.now.denominator,
      });
    }
  }

  return { ...opts, facts, omitted };
}

/* ── Talking to the model ────────────────────────────────────────────────── */

const fmtCount = (v: number) =>
  Math.round(v).toLocaleString("en-US");
const fmtPercent = (v: number) => `${v.toFixed(1)}%`;
const fmtSigned = (v: number, unit: string) =>
  `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}${unit}`;

/** Every slot a fact offers, already formatted the way it will be printed. */
export function slotsOf(f: Fact): Record<string, string | null> {
  const fmt = f.unit === "percent" ? fmtPercent : fmtCount;
  return {
    what: f.what,
    value: fmt(f.value),
    prev: f.prev == null ? null : fmt(f.prev),
    change: f.changePct == null ? null : fmtSigned(f.changePct, "%"),
    points: f.changePts == null ? null : fmtSigned(f.changePts, " points"),
    denominator: f.denominator == null ? null : fmtCount(f.denominator),
  };
}

export function renderPack(pack: FactPack): string {
  const lines = pack.facts.map((f) => {
    const s = slotsOf(f);
    const parts = [`${f.id}: ${f.what} — {{${f.id}.value}} = ${s.value}`];
    if (s.prev) parts.push(`previously {{${f.id}.prev}} = ${s.prev}`);
    if (s.change) parts.push(`change {{${f.id}.change}} = ${s.change}`);
    if (s.points) parts.push(`in points {{${f.id}.points}} = ${s.points}`);
    if (s.denominator) parts.push(`out of {{${f.id}.denominator}} = ${s.denominator}`);
    return parts.join("; ");
  });
  return lines.join("\n");
}

export const SYSTEM_PROMPT = `You are writing a short briefing on Hugging Face developer activity for a technical stakeholder who will act on it.

You are given a numbered list of facts. Each fact offers named slots, written {{F1.value}}, {{F1.change}} and so on.

THE ONE HARD RULE: you must not write any digit anywhere in your answer. Every number you want to state must be written as a slot, and the server substitutes the real figure afterwards. "{{F4.value}} new Spaces" is correct. "1,462 new Spaces" is not, and neither is "about 1,500", "roughly a thousand" is acceptable only if it contains no digits — but prefer a slot. Write "the top three" as "the top three", in words.

Only use slots that appear in the list. A slot that is not listed for a fact does not exist; do not invent one, and do not use a fact's change slot if the list does not show one, because that means there was nothing comparable to measure it against.

Otherwise:
- Two or three short paragraphs. Lead with the largest genuine movement.
- Say what changed and what it means, not what every fact says. A list of facts read aloud is not a briefing.
- Do not speculate beyond the facts you were given. If they do not support a claim, do not make it.
- If the coverage fact shows a low figure, say plainly that the classification-derived figures for this period are missing rather than low, and do not draw conclusions from categories.
- Past tense. No headings, no bullet points, no preamble — just the paragraphs.`;

/* ── Checking what came back ─────────────────────────────────────────────── */

const SLOT = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\.\s*([a-zA-Z]+)\s*\}\}/g;
const ANY_BRACES = /\{\{[^}]*\}\}/g;

export interface GroundResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Replaces every slot with its figure, and refuses anything else.
 *
 * Three ways to fail, and each one is a different lie the prose would have
 * told: a slot naming a fact that was not in the pack (a figure from nowhere),
 * a slot naming an absent value (a change we said we could not measure), and a
 * digit written directly (a number the model chose itself).
 */
export function ground(text: string, facts: readonly Fact[]): GroundResult {
  const byId = new Map(facts.map((f) => [f.id, slotsOf(f)]));

  const bad: string[] = [];
  const filled = text.replace(SLOT, (whole, id: string, slot: string) => {
    const slots = byId.get(id);
    if (!slots) { bad.push(`${whole} names a fact that was not in the pack`); return whole; }
    const v = slots[slot];
    if (v == null) {
      bad.push(`${whole} asks for a figure this fact does not have`);
      return whole;
    }
    return v;
  });
  if (bad.length) return { ok: false, text: "", error: bad.slice(0, 4).join("; ") };

  // Anything still in braces was not a slot at all.
  const leftover = filled.match(ANY_BRACES);
  if (leftover) return { ok: false, text: "", error: `unrecognised placeholder ${leftover[0]}` };

  // And the model must not have written a figure of its own. Checked on the
  // ORIGINAL text with slots removed, so a substituted 1,462 is not mistaken
  // for one the model typed.
  const withoutSlots = text.replace(SLOT, "");
  const stray = /[0-9]/.exec(withoutSlots);
  if (stray) {
    const at = Math.max(0, stray.index - 30);
    return {
      ok: false, text: "",
      error: `wrote a digit of its own near: "${withoutSlots.slice(at, stray.index + 30).trim()}"`,
    };
  }

  return { ok: true, text: filled };
}

/* ── The whole thing ─────────────────────────────────────────────────────── */

export interface InsightResult {
  kind: InsightKind;
  periodKey: string;
  narrative: string;
  facts: Fact[];
  status: "ok" | "ungrounded" | "insufficient" | "error";
  detail: string | null;
  inputTokens: number;
  outputTokens: number;
}

/** Below this there is nothing worth a paragraph, let alone a model call. */
export const MIN_FACTS = 4;

export async function generateInsight(
  client: BedrockClient,
  modelId: string,
  pack: FactPack,
  { attempts = 2 }: { attempts?: number } = {},
): Promise<InsightResult> {
  const base = {
    kind: pack.kind, periodKey: pack.periodKey, facts: pack.facts,
    inputTokens: 0, outputTokens: 0,
  };

  if (pack.facts.length < MIN_FACTS) {
    return {
      ...base, narrative: "", status: "insufficient",
      detail: `only ${pack.facts.length} usable facts` +
        (pack.omitted.length ? `; omitted: ${pack.omitted.join("; ")}` : ""),
    };
  }

  const intro = `Period: ${pack.periodLabel}` +
    (pack.previousLabel ? `, compared with ${pack.previousLabel}` : ", with nothing before it to compare against") +
    `.\n\nFacts:\n${renderPack(pack)}`;

  let inputTokens = 0, outputTokens = 0, lastError = "no attempt was made";
  const messages: BedrockRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: intro }] },
  ];

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await client.invoke(modelId, {
        anthropic_version: "bedrock-2023-05-31",
        // Generous: these models think before they write, and the thinking
        // comes out of the same budget as the prose.
        max_tokens: 8192,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages,
      });
    } catch (err) {
      return {
        ...base, narrative: "", status: "error",
        detail: err instanceof Error ? err.message : String(err),
        inputTokens, outputTokens,
      };
    }
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    const raw = firstText(response).trim();
    const checked = ground(raw, pack.facts);
    if (checked.ok) {
      return {
        ...base, narrative: checked.text, status: "ok", detail: null,
        inputTokens, outputTokens,
      };
    }
    lastError = checked.error ?? "failed validation";

    // Told exactly what was wrong, once. A model that cannot ground its
    // numbers on a second look is not going to on a third, and a summary that
    // is quietly wrong is worse than a card that says it could not be written.
    messages.push(
      { role: "assistant", content: [{ type: "text", text: raw }] },
      {
        role: "user",
        content: [{
          type: "text",
          text: `That failed the grounding check: ${lastError}. Rewrite it. Every figure must be a slot from the list, and your answer must contain no digits at all.`,
        }],
      },
    );
  }

  return {
    ...base, narrative: "", status: "ungrounded",
    detail: lastError, inputTokens, outputTokens,
  };
}

/* ── Which period a summary is about ─────────────────────────────────────── */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

const monthKeyOf = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** Every Monday that belongs to a month, by the rule the dashboard buckets by. */
export function mondaysOfMonth(key: string): string[] {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return [];
  const cursor = new Date(Date.UTC(y, m - 1, 1));
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() + 1);
  const weeks: string[] = [];
  while (monthKeyOf(cursor) === key) {
    weeks.push(isoOf(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

/**
 * The weeks a summary covers, and the weeks it is measured against.
 *
 * One definition, used by the weekly run and by the repair endpoint, so a
 * summary written by hand covers exactly the same span as one written by cron.
 * Two answers to "which weeks is August?" is how a repaired month ends up
 * disagreeing with the month beside it.
 */
export function periodSpec(kind: InsightKind, periodKey: string): BuildPackOptions | null {
  if (kind === "week") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) return null;
    const monday = new Date(`${periodKey}T00:00:00.000Z`);
    if (!Number.isFinite(monday.getTime()) || monday.getUTCDay() !== 1) return null;
    const prev = isoOf(new Date(monday.getTime() - 7 * 86_400_000));
    const longWeek = (iso: string) => {
      const d = new Date(`${iso}T00:00:00.000Z`);
      return `the week of ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]?.slice(0, 3)} ${d.getUTCFullYear()}`;
    };
    return {
      kind: "week", periodKey,
      periodLabel: longWeek(periodKey), previousLabel: longWeek(prev),
      weeks: [periodKey], previousWeeks: [prev],
    };
  }

  if (!/^\d{4}-\d{2}$/.test(periodKey)) return null;
  const weeks = mondaysOfMonth(periodKey);
  if (!weeks.length) return null;
  const [y, m] = periodKey.split("-").map(Number);
  const prevKey = monthKeyOf(new Date(Date.UTC(y!, m! - 2, 1)));
  const named = (key: string) => {
    const [yy, mm] = key.split("-");
    return `${MONTH_NAMES[Number(mm) - 1]} ${yy}`;
  };
  return {
    kind: "month", periodKey,
    periodLabel: named(periodKey), previousLabel: named(prevKey),
    weeks, previousWeeks: mondaysOfMonth(prevKey),
  };
}

/* ── Schema bootstrap ────────────────────────────────────────────────────── */

/**
 * The insights schema, verbatim from migrations/0006_insights.sql.
 *
 * D1 has no migrate-on-deploy. `git push` ships the Worker; a human runs
 * `wrangler d1 migrations apply`. Those two steps drift, and this repo has
 * already paid for that drift twice — once with a run that died on a missing
 * column a third of the way in, and once with a summary card that hid itself
 * for weeks because the feature behind it had never been switched on.
 *
 * A table nobody remembers to create is a feature that is dark. So the code
 * that needs this table can create it, once, the first time it finds it
 * missing. Deliberately narrow: two idempotent CREATEs of a table this feature
 * owns outright, with no data to migrate and no other reader. It is not a
 * migration runner and must not become one — anything that alters an existing
 * table, or touches a table another phase writes, belongs in migrations/ and
 * nowhere else.
 *
 * The two paths cannot drift: a test drops the table the migration built,
 * rebuilds it from these constants, and compares sqlite_master byte for byte.
 * Applying the migration afterwards is a clean no-op.
 *
 * No SQL comments in the constant, deliberately. `wrangler d1 migrations apply`
 * strips them before executing, so SQLite stores the migration's DDL without
 * them; leaving them here would make the two stored schemas differ by
 * whitespace alone and the drift test would fail for the one reason that does
 * not matter. The commentary lives in migrations/0006_insights.sql, which is
 * where someone reading the schema will look.
 */
export const INSIGHTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS hf_insights (
  id                INTEGER PRIMARY KEY,

  
  
  kind              TEXT NOT NULL CHECK (kind IN ('week', 'month')),
  
  period_key        TEXT NOT NULL,
  
  
  week_start        TEXT,

  taxonomy_version  TEXT NOT NULL,

  
  
  narrative         TEXT NOT NULL,
  
  
  
  facts             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(facts)),

  
  
  status            TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok', 'ungrounded', 'insufficient', 'error')),
  detail            TEXT,

  model_id          TEXT,
  prompt_version    TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  generated_at      TEXT NOT NULL,

  UNIQUE (kind, period_key, taxonomy_version)
) STRICT;`;

export const INSIGHTS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_insights_recent ON hf_insights (kind, period_key DESC);`;

/** True when a D1 failure is this table simply not being there yet. */
export function isMissingInsightsTable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /no such table:\s*(main\.)?hf_insights/i.test(text);
}

/**
 * Creates the table if it is missing. Idempotent, and cheap to call.
 *
 * Callers reach this only after a statement has already failed, so the happy
 * path never pays for it.
 */
export async function ensureInsightsSchema(db: D1Database): Promise<void> {
  await db.prepare(INSIGHTS_TABLE_SQL).run();
  await db.prepare(INSIGHTS_INDEX_SQL).run();
}

/**
 * Runs an operation, and if the only thing wrong was the missing table,
 * creates it and tries exactly once more.
 *
 * Once more, not in a loop: a second failure is a real failure, and retrying a
 * genuine error forever is how a page-load turns into a timeout.
 */
export async function withInsightsSchema<T>(
  db: D1Database,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isMissingInsightsTable(err)) throw err;
    await ensureInsightsSchema(db);
    return await run();
  }
}

/* ── Storing it ──────────────────────────────────────────────────────────── */

export async function saveInsight(
  db: D1Database,
  result: InsightResult,
  { weekStart, modelId, generatedAt }:
    { weekStart: string | null; modelId: string; generatedAt: string },
): Promise<void> {
  await withInsightsSchema(db, () => db
    .prepare(
      `INSERT INTO hf_insights
         (kind, period_key, week_start, taxonomy_version, narrative, facts,
          status, detail, model_id, prompt_version, input_tokens, output_tokens, generated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
       ON CONFLICT(kind, period_key, taxonomy_version) DO UPDATE SET
         week_start = excluded.week_start,
         narrative = excluded.narrative,
         facts = excluded.facts,
         status = excluded.status,
         detail = excluded.detail,
         model_id = excluded.model_id,
         prompt_version = excluded.prompt_version,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         generated_at = excluded.generated_at`,
    )
    .bind(
      result.kind, result.periodKey, weekStart, TAXONOMY_VERSION,
      result.narrative, JSON.stringify(result.facts),
      result.status, result.detail, modelId, INSIGHT_PROMPT_VERSION,
      result.inputTokens, result.outputTokens, generatedAt,
    )
    .run());
}
