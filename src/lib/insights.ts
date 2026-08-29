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
/**
 * How far two periods' coverage may differ before a change between them is a
 * change in the classifier rather than in the Hub.
 *
 * The floor above decides whether a period's classification figures may be
 * REPORTED. This decides whether two of them may be COMPARED, which is a
 * different question and was not being asked. The week of 10 Aug 2026 is 100%
 * classified; the week before it is 21.7%, because the LLM stage never ran
 * (`bySource {rule: 1250, model: 0}`), so its classified set is the
 * keyword-settleable subset. A ratio between those two is arithmetic on two
 * different populations, and it produced falls out of rises everywhere it was
 * allowed to: Agentic went from 112 Spaces to 332 and read as down 33.5%.
 *
 * Grounding does not protect against this. The figure genuinely comes from the
 * pack; the pack is what is wrong. So the change slots are withheld and the
 * model cannot cite what it was never given.
 */
export const MAX_COVERAGE_GAP = 10;
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
  /**
   * Where the figure came from, when it came from a cut.
   *
   * Two jobs. It lets confidence be DERIVED rather than asserted — a figure
   * from a classifier-derived cut inherits the classifier's uncertainty, and a
   * headline count from hf_spaces does not. And it lets the dashboard draw a
   * card's sparkline from the series it has already loaded, so the little chart
   * on a card and the big chart on another tab cannot disagree.
   *
   * Null for figures that are not a cut row — coverage, and the headline
   * totals.
   */
  cut: string | null;
  dimension: string | null;
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

/**
 * The coverage of one period, as a PERCENTAGE, pooled by the Spaces it covers.
 *
 * Three things this has to get right, and the first one is why it exists.
 *
 * `aggregate.ts` stores coverage as a RATIO — `classified / denominator`, so
 * 1 for a fully classified week and 0.2168 for the week of 3 Aug. Every
 * threshold here is a percentage. Comparing the two directly meant
 * `coverage >= 40` could never be true for a real pipeline row, so every
 * classification-derived fact was omitted from every pack, and the one fact
 * that did survive reported a 100% week as "1.0%". The unit conversion happens
 * here, once, at the boundary where the stored value is read.
 *
 * A month holds several weeks, and every row of a week repeats that week's
 * coverage. Averaging the rows therefore weights each week by how many use
 * cases it happened to see, not by how many Spaces it had. Pooling by the
 * denominator is the same rule the rest of the dashboard uses.
 *
 * A week where nothing was classified writes no `spaces_by_use_case` rows at
 * all, so it vanishes from an average taken over them — and a vanished zero
 * flatters the month it belonged to. The denominators come from the SDK cut,
 * which has a row for every new Space whatever the classifier did.
 */
function pooledCoverage(rows: readonly MetricRow[], weeks: readonly string[]): number | null {
  let num = 0, den = 0;
  for (const week of weeks) {
    const sdk = rows.filter((r) => r.metric_cut === "sdk_distribution" && r.week_start === week);
    const spaces = sdk.reduce((sum, r) => sum + r.value, 0);
    if (spaces <= 0) continue;                       // the week did not run at all
    const cov = rows.find((r) => r.metric_cut === "spaces_by_use_case" && r.week_start === week);
    // Present but unclassified is a real zero and must not disappear.
    num += (cov?.coverage ?? 0) * 100 * spaces;
    den += spaces;
  }
  return den > 0 ? num / den : null;
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
  const add = (f: Omit<Fact, "id" | "cut" | "dimension"> & { cut?: string; dimension?: string }): void => {
    facts.push({ id: `F${++n}`, cut: null, dimension: null, ...f });
  };

  const inNow = (r: MetricRow) => opts.weeks.includes(r.week_start);
  const inPrev = (r: MetricRow) => opts.previousWeeks.includes(r.week_start);

  if (rows.length === 0) {
    return { ...opts, facts: [], omitted: ["no metrics have been computed for this period"] };
  }

  /* Coverage first, because it decides what else is allowed in. */
  const coverage = pooledCoverage(rows, opts.weeks);
  const prevCoverage = pooledCoverage(rows, opts.previousWeeks);
  const classifiable = coverage != null && coverage >= MIN_COVERAGE;

  // The denominator of "the share we could classify" is every new Space, not
  // the classified ones. The SDK cut has a row for each.
  const totalSpaces = rows
    .filter((r) => r.metric_cut === "sdk_distribution" && inNow(r))
    .reduce((s, r) => s + r.value, 0);

  // Reporting and comparing are two questions and only the first was asked.
  // The earlier period must clear the floor in its own right — a 5-point gap
  // between 40% and 35% is a small gap between one figure this module trusts
  // and one it does not — and the two must then be close enough that a ratio
  // between them is a ratio of the Hub rather than of the classifier.
  const comparable = classifiable
    && prevCoverage != null
    && prevCoverage >= MIN_COVERAGE
    && Math.abs(coverage! - prevCoverage) <= MAX_COVERAGE_GAP;

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
  } else if (!comparable) {
    omitted.push(
      `every classification-derived CHANGE: this period was ${coverage!.toFixed(1)}% classified and the one before it ${
        prevCoverage == null ? "not recorded" : prevCoverage.toFixed(1) + "%"
      }, so a ratio between them would be a ratio of the classifier rather than of the Hub`,
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
      // The cut it was summed from, with no dimension: this is the whole of it,
      // not one category. A sparkline for it is the total line.
      cut,
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
      // A classification-derived cut gets no comparison at all when the two
      // periods were classified to different depths: no prev, no change, no
      // points. Withheld by ABSENCE from the pack rather than by an instruction
      // in the prompt, so the model cannot cite what it was never given.
      const prev = NEEDS_COVERAGE.has(cut) && !comparable ? null : s.prev.value;
      add({
        what: (WHAT[cut] ?? ((d: string) => `${cut} ${label(d)}`))(s.dim),
        unit: kind === "percent" ? "percent" : "count",
        value,
        prev,
        changePct: prev ? ((value - prev) / prev) * 100 : null,
        changePts: kind === "percent" && prev != null ? value - prev : null,
        denominator: s.now.denominator,
        cut,
        dimension: s.dim,
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
  /** The findings behind the narrative. Empty for a period written before cards. */
  cards?: InsightCard[];
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
 * Whether a period is still running, by the same clock the dashboard uses.
 *
 * A period is finished when its LAST WEEK has finished — not when the calendar
 * month ends. A week whose Monday is 31 August belongs to August and runs into
 * September, so August is not done until that week is, and a summary written a
 * day earlier would describe a month it had only partly seen.
 *
 * This exists because the endpoint and the cron path had different answers.
 * The cron path never asks about an open period; the endpoint takes whatever it
 * is given, and the tab prints "Written once a month closes, never part-way
 * through it" directly above the result. A promise on the page that the data
 * can contradict is the defect this whole feature was built to avoid.
 */
export function periodIsOpen(
  kind: InsightKind,
  periodKey: string,
  now: number = Date.now(),
): boolean {
  const lastWeek = kind === "week" ? periodKey : mondaysOfMonth(periodKey).at(-1);
  if (!lastWeek) return true;
  const ends = Date.parse(`${lastWeek}T00:00:00.000Z`) + 7 * 86_400_000;
  return !Number.isFinite(ends) || now < ends;
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
    if (!Number.isFinite(monday.getTime())) return null;
    // V8 rolls a date that does not exist forward instead of rejecting it:
    // "2026-02-30" parses to Monday 2 March. The weekday test alone therefore
    // passes, and the row would be stored under a key no metric exists for and
    // no calendar contains — visible in /api/insights for good. Round-tripping
    // the parsed date back to a string is what catches it.
    if (isoOf(monday) !== periodKey) return null;
    if (monday.getUTCDay() !== 1) return null;
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

/**
 * Migration 0010, repeated here for the self-healing path.
 *
 * It has to be a separate ALTER rather than a column in the CREATE above,
 * because SQLite stores the text of the statement that made a table and
 * appends to it on ALTER. A database built by the migrations holds
 * "CREATE TABLE ... generated_at TEXT NOT NULL, ... ) STRICT, cards TEXT" —
 * and one built from a single CREATE with the column inline would not, even
 * though the two tables are identical in every way that matters. The test that
 * compares them byte for byte is what keeps this file honest about the schema,
 * so the healing path takes the same two steps the migrations take.
 *
 * ALTER TABLE has no IF NOT EXISTS, so running it twice is expected to fail
 * and the failure is discarded.
 */
export const INSIGHTS_CARDS_SQL = `ALTER TABLE hf_insights ADD COLUMN cards TEXT;`;

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
  // Already there on every database the migrations have touched. The throw is
  // the normal case, not an error worth reporting.
  try {
    await db.prepare(INSIGHTS_CARDS_SQL).run();
  } catch {
    /* duplicate column name: cards */
  }
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
         (kind, period_key, week_start, taxonomy_version, narrative, facts, cards,
          status, detail, model_id, prompt_version, input_tokens, output_tokens, generated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
       ON CONFLICT(kind, period_key, taxonomy_version) DO UPDATE SET
         week_start = excluded.week_start,
         narrative = excluded.narrative,
         facts = excluded.facts,
         cards = excluded.cards,
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
      result.cards && result.cards.length ? JSON.stringify(result.cards) : null,
      result.status, result.detail, modelId, INSIGHT_PROMPT_VERSION,
      result.inputTokens, result.outputTokens, generatedAt,
    )
    .run());
}

/* ── Cards ───────────────────────────────────────────────────────────────── */

/**
 * The weekly summary as a set of findings rather than a paragraph.
 *
 * The prose version worked and stays grounded the same way, but it asked a
 * reader to hold nine figures in their head to notice one of them mattered.
 * A card names one thing, shows the number it rests on, and says which facts
 * it used.
 *
 * THREE PROPERTIES, AND ALL THREE ARE ENFORCED HERE RATHER THAN ASKED FOR.
 *
 *  1. No invented figures. Every number is a {{F5.value}} slot substituted
 *     after the fact, and `ground()` rejects any answer containing a digit the
 *     model typed itself. Unchanged from the prose path.
 *
 *  2. No invented DIRECTION. A card saying something grew must cite a fact
 *     that grew. The model cannot see this rule coming and cannot talk its way
 *     past it: checkClaims reads the text it wrote against the numbers it was
 *     given, and drops the card if they disagree. Grounding stops "8,398 new
 *     models" when the figure is 8,397; this stops "up sharply" when the pack
 *     contains no comparison at all — which is the whole of this dataset today.
 *
 *  3. Confidence is DERIVED, never asserted. A model asked how sure it is will
 *     answer fluently and without information. So it is not asked. Confidence
 *     falls out of the data the card rests on: how big the base is, and whether
 *     the figures come from a classifier that flagged 45.3% of its own answers
 *     as low-confidence.
 */

export const CARD_CATEGORIES = ["change", "structural", "risk", "opportunity", "watch"] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];
export type CardConfidence = "high" | "medium" | "low";

export interface InsightCard {
  id: string;
  category: CardCategory;
  /** Grounded. One line, the finding itself. */
  headline: string;
  /** Grounded. Two or three sentences saying why it is the finding. */
  body: string;
  /** The fact whose figure is shown large. */
  heroFact: string;
  /** Grounded. The line under the big number. */
  heroCaption: string;
  /** Every fact the card used, hero included. */
  facts: string[];
  /** Derived here, not by the model. */
  confidence: CardConfidence;
  /** For the sparkline, taken from the hero fact's provenance. */
  spark: { cut: string; dimension: string | null } | null;
}

export interface CardsResult {
  /** A short grounded paragraph, for the overview card. */
  summary: string;
  cards: InsightCard[];
  status: "ok" | "ungrounded" | "insufficient" | "error";
  detail: string | null;
  inputTokens: number;
  outputTokens: number;
}

/** Below this base, a share is not a finding whatever it says. */
const CARD_MIN_BASE = 100;

/**
 * Above this share of low-confidence classifications, anything resting on the
 * classifier is medium at best.
 *
 * 0.35 rather than 0.5 because the figure it is judging is currently 0.453 —
 * 2,647 of 5,842 — and a threshold set above the number it exists to catch is
 * a threshold that has never been tested.
 */
const LOW_CONFIDENCE_CEILING = 0.35;

/** Words that assert a direction, and the sign they require. */
const CLAIM_WORDS: ReadonlyArray<readonly [RegExp, 1 | -1]> = [
  [/\b(grew|grow|growing|rose|rising|risen|climbed|climbing|increased|increasing|gained|gaining|up|higher|more than (?:it|the previous|last)|surged|jumped)\b/i, 1],
  [/\b(fell|fall|fallen|falling|dropped|dropping|declined|declining|shrank|shrunk|shrinking|lost|losing|down|lower|less than (?:it|the previous|last)|collapsed|slid)\b/i, -1],
];

const SUPERLATIVE = /\b(largest|biggest|most|leading|leads|led|dominant|dominates|top|highest|greatest|smallest|fewest|lowest)\b/i;

/**
 * Buckets that are the absence of an answer, not an answer.
 *
 * They must not be treated as peers of a real category, or the largest use case
 * on the Hub is permanently "everything else" and no true sentence can be
 * written about what people build. They are also not to be waved away: when one
 * of them outranks the category being called the largest, the claim has to say
 * so — see the qualifier rule below.
 */
const RESIDUAL_DIMENSIONS = new Set(["other", "unresolved", "other-open", "unknown", "none"]);

/** A claim that acknowledges the residual outranks it. */
const QUALIFIED = /\b(named|identified|recognis(?:ed|able)|classified|labelled|labeled|specific)\b/i;

/**
 * Does what the card SAYS agree with the numbers it was given?
 *
 * Returns the reason it does not, or null when it holds. Run before grounding,
 * on the text with its slots still in, so a substituted figure cannot be read
 * as prose.
 */
export function checkClaims(
  card: Pick<InsightCard, "headline" | "body" | "heroCaption" | "heroFact" | "facts">,
  facts: readonly Fact[],
): string | null {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const hero = byId.get(card.heroFact);
  if (!hero) return `hero fact ${card.heroFact} is not in the pack`;

  for (const id of card.facts) {
    if (!byId.has(id)) return `cites ${id}, which is not in the pack`;
  }
  if (!card.facts.includes(card.heroFact)) return `hero fact ${card.heroFact} is not in its own fact list`;

  const text = `${card.headline} ${card.body} ${card.heroCaption}`;

  for (const [re, sign] of CLAIM_WORDS) {
    if (!re.test(text)) continue;
    // A direction claim needs a comparison somewhere in what it cited. When
    // the pack has no previous period — which is every week this database
    // currently holds — there is no such fact, and the claim is unfounded
    // rather than merely unsupported.
    const moved = card.facts
      .map((id) => byId.get(id))
      .filter((f): f is Fact => !!f && f.changePct != null);
    if (moved.length === 0) {
      return `says "${re.exec(text)?.[0]}" but no fact it cites has a comparison to the period before`;
    }
    if (!moved.some((f) => Math.sign(f.changePct as number) === sign)) {
      return `says "${re.exec(text)?.[0]}" but every fact it cites moved the other way`;
    }
  }

  if (SUPERLATIVE.test(text) && hero.cut) {
    const all = facts.filter((f) => f.cut === hero.cut && f.dimension != null);
    const named = all.filter((f) => !RESIDUAL_DIMENSIONS.has(f.dimension as string));
    const smallest = /\b(smallest|fewest|lowest)\b/i.test(text);
    const pick = (xs: Fact[]) =>
      smallest ? Math.min(...xs.map((f) => f.value)) : Math.max(...xs.map((f) => f.value));

    if (named.length > 1 && hero.value !== pick(named)) {
      return `claims a superlative but ${hero.id} is not the ${smallest ? "smallest" : "largest"} of its cut in the pack`;
    }
    // It leads the real categories but a residual bucket is bigger. That is a
    // true and useful thing to say, and it is only true with the qualifier —
    // "the largest use case" would be false while "the largest named use case"
    // is exactly right.
    if (all.length > named.length && hero.value !== pick(all) && !QUALIFIED.test(text)) {
      return `claims a superlative over a residual bucket that is larger; say "named" (or "identified") if the claim is about the named categories`;
    }
  }

  return null;
}

/**
 * How much weight a card's figures can carry.
 *
 * Not a judgement about the writing — a statement about the data underneath.
 * A count of new Spaces from hf_spaces is a census; the same count split by
 * use case has been through a classifier that flagged nearly half its own
 * answers, and no amount of careful prose changes that.
 */
export function confidenceOf(
  card: Pick<InsightCard, "facts">,
  facts: readonly Fact[],
  lowConfidenceShare: number | null,
): CardConfidence {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const cited = card.facts.map((id) => byId.get(id)).filter((f): f is Fact => !!f);

  const bases = cited.map((f) => f.denominator).filter((d): d is number => d != null);
  if (bases.length > 0 && Math.min(...bases) < CARD_MIN_BASE) return "low";

  const classifierDerived = cited.some((f) => f.cut != null && NEEDS_COVERAGE.has(f.cut));
  if (classifierDerived && lowConfidenceShare != null && lowConfidenceShare > LOW_CONFIDENCE_CEILING) {
    return "medium";
  }

  return "high";
}

const CARDS_SYSTEM_PROMPT = `You write the weekly findings for a dashboard about what developers
are building on Hugging Face.

You are given a numbered list of facts. That list is the only thing you know.

ABSOLUTE RULES
- Never write a digit. Not one. Every figure is a slot: {{F5.value}}, {{F5.prev}},
  {{F5.changePct}}, {{F5.changePts}}, {{F5.denominator}}. They are substituted after you finish.
- Only use a slot for a fact that is in the list, and only for a figure that fact has. A fact
  with no prev has no change; do not reach for one.
- Never say something rose, fell, grew or dropped unless a fact you cite has a change figure.
  Most weeks here have no comparison at all. When there is none, describe what IS, not what moved.
- Do not say how confident you are, or call anything significant, notable or striking.
  Confidence is computed from the data and added after you finish.

WHAT TO WRITE ABOUT
Lead with what people are BUILDING and for WHOM: the use cases new Spaces serve, the techniques
they use, the industry verticals they point at. Model families are context for those, not the
subject. A reader wants to know what is being made, not which base model won.

THE CARDS
Return between six and ten. Each is one finding, and each must stand alone.
- category: one of change, structural, risk, opportunity, watch.
    change      - something moved against the period before. Needs a fact with a change figure.
    structural  - a durable property of the mix. The default when there is no comparison.
    risk        - something that undermines a reading: thin coverage, a large residual bucket,
                  a category resting on very few Spaces.
    opportunity - a gap: something served far less than the surrounding activity suggests.
    watch       - small now, worth a second look, explicitly not yet a trend.
- headline: one line, the finding itself, specific.
- body: two or three sentences. Say what the figure is and why it is the finding.
- heroFact: the id of the fact whose figure is shown large.
- heroCaption: a short line to sit under that figure.
- facts: every fact id you used, including the hero.

The "everything else" and "unresolved" buckets are residuals — the absence of a classification,
not a category anyone chose. Never call one of them a use case or a family. If a named category
leads the real ones while a residual is bigger, say "the largest NAMED use case", never "the
largest use case".

Do not write ten cards about the same cut. Spread them across use cases, techniques, verticals,
tooling and volume. If the facts do not support ten, write fewer.

RETURN
A single JSON object and nothing else. No prose before it, no code fence around it.
{"summary": "...", "cards": [{"category": "...", "headline": "...", "body": "...",
 "heroFact": "F5", "heroCaption": "...", "facts": ["F5", "F3"]}]}
The summary is one short paragraph for the top of the dashboard, under the same rules.`

/** ```json fences and stray prose around the object. */
export function stripFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/** Kept as documentation of the shape, and asserted against in the tests. */
const CARDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "cards"],
  properties: {
    summary: { type: "string" },
    cards: {
      type: "array",
      minItems: 4,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "headline", "body", "heroFact", "heroCaption", "facts"],
        properties: {
          category: { type: "string", enum: [...CARD_CATEGORIES] },
          headline: { type: "string" },
          body: { type: "string" },
          heroFact: { type: "string" },
          heroCaption: { type: "string" },
          facts: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  },
} as const;

/**
 * One call, both outputs.
 *
 * The overview paragraph and the cards come from the same generation on
 * purpose: two calls would be two readings of the same week, and the day they
 * disagreed nobody would know which to believe.
 */
export async function generateCards(
  client: BedrockClient,
  modelId: string,
  pack: FactPack,
  options: { attempts?: number; lowConfidenceShare?: number | null } = {},
): Promise<CardsResult> {
  const { attempts = 2, lowConfidenceShare = null } = options;
  const base = { summary: "", cards: [] as InsightCard[], inputTokens: 0, outputTokens: 0 };

  if (pack.facts.length < MIN_FACTS) {
    return {
      ...base, status: "insufficient",
      detail: `only ${pack.facts.length} usable facts` +
        (pack.omitted.length ? `; omitted: ${pack.omitted.join("; ")}` : ""),
    };
  }

  const intro = `Period: ${pack.periodLabel}` +
    (pack.previousLabel
      ? `, compared with ${pack.previousLabel}`
      : ", with nothing before it to compare against, so no fact has a change figure") +
    `.\n\nFacts:\n${renderPack(pack)}`;

  const messages: BedrockRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: intro }] },
  ];
  let inputTokens = 0, outputTokens = 0, lastError = "no attempt was made";

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await client.invoke(modelId, {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 8192,
        system: [{ type: "text", text: CARDS_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages,
        // No output_config. Bedrock accepts it for Haiku 4.5 and rejects it for
        // Opus 5 with "output_config.format: Extra inputs are not permitted",
        // and the narration model is the one that matters here. The shape is
        // carried in the prompt instead and enforced on the way back — which
        // this path already did, because a schema would not have caught a
        // fabricated direction anyway.
      });
    } catch (err) {
      return {
        ...base, status: "error",
        detail: err instanceof Error ? err.message : String(err),
        inputTokens, outputTokens,
      };
    }
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    const raw = firstText(response).trim();
    let parsed: { summary: string; cards: Array<Omit<InsightCard, "id" | "confidence" | "spark">> };
    try {
      parsed = JSON.parse(stripFence(raw));
    } catch {
      lastError = "the answer was not JSON";
      messages.push(
        { role: "assistant", content: [{ type: "text", text: raw }] },
        { role: "user", content: [{ type: "text", text: "That was not valid JSON. Return only the object." }] },
      );
      continue;
    }

    const byId = new Map(pack.facts.map((f) => [f.id, f]));
    const kept: InsightCard[] = [];
    const rejected: string[] = [];

    for (const card of parsed.cards) {
      // Claims first: it reads the text with slots intact, and a card that
      // fails here is wrong about the data rather than merely unformatted.
      const claim = checkClaims(card, pack.facts);
      if (claim) { rejected.push(`${card.headline.slice(0, 40)}: ${claim}`); continue; }

      const parts = [card.headline, card.body, card.heroCaption].map((t) => ground(t, pack.facts));
      const bad = parts.find((p) => !p.ok);
      if (bad) { rejected.push(`${card.headline.slice(0, 40)}: ${bad.error}`); continue; }

      const hero = byId.get(card.heroFact)!;
      kept.push({
        id: `I${kept.length + 1}`,
        category: card.category,
        headline: parts[0]!.text,
        body: parts[1]!.text,
        heroFact: card.heroFact,
        heroCaption: parts[2]!.text,
        facts: card.facts,
        confidence: confidenceOf(card, pack.facts, lowConfidenceShare),
        spark: hero.cut ? { cut: hero.cut, dimension: hero.dimension } : null,
      });
    }

    const summary = ground(parsed.summary, pack.facts);

    // Some cards surviving is a good week; none surviving means the model did
    // not understand the pack, and half a page of findings is worse than a
    // card saying none could be written.
    if (summary.ok && kept.length >= 4) {
      return {
        summary: summary.text, cards: kept, status: "ok",
        detail: rejected.length ? `${rejected.length} card(s) dropped: ${rejected.slice(0, 3).join("; ")}` : null,
        inputTokens, outputTokens,
      };
    }

    lastError = !summary.ok
      ? `summary: ${summary.error}`
      : `only ${kept.length} of ${parsed.cards.length} cards survived: ${rejected.slice(0, 3).join("; ")}`;

    messages.push(
      { role: "assistant", content: [{ type: "text", text: raw }] },
      {
        role: "user",
        content: [{
          type: "text",
          text: `That did not pass: ${lastError}. Rewrite it. Every figure must be a slot from the list, ` +
            `you must write no digits at all, and you must not say anything rose or fell unless a fact you cite has a change figure.`,
        }],
      },
    );
  }

  return { ...base, status: "ungrounded", detail: lastError, inputTokens, outputTokens };
}
