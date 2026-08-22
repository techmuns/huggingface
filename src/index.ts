import { aggregateWeeklyMetrics } from "./lib/aggregate";
import { isAuthorized } from "./lib/auth";
import { decodeBase64Utf8 } from "./lib/snapshot";
import { TAXONOMY_VERSION, USE_CASES } from "./lib/taxonomy";
import { isoWeekLabel, weekStartIso } from "./lib/time";
import type { WeeklyPipelineParams } from "./workflow";

export { WeeklyPipeline } from "./workflow";

const WEEK_MS = 7 * 86_400_000;

/**
 * Upper bound on a requested backfill.
 *
 * 12 weeks is what the dashboard's longest comparison window needs. The cap
 * exists because backfill length multiplies straight into request volume
 * against the Hub's rate limit, so an unbounded value from a request body
 * would be a self-inflicted outage.
 */
const MAX_BACKFILL_WEEKS = 26;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // `deployedAt` is what makes a run attributable. A push and its deploy
      // are minutes apart, and a run started inside that gap executes the
      // previous version — which today produced a failure blamed on code that
      // had already been fixed. Compare this against the commit timestamp
      // before concluding anything from a run's outcome.
      const version = env.CF_VERSION_METADATA;
      return Response.json({
        status: "ok",
        version: version?.id ?? null,
        deployedAt: version?.timestamp ?? null,
      });
    }

    if (url.pathname === "/api/admin/run") {
      return handleAdminRun(request, env, url);
    }

    if (url.pathname === "/api/admin/runs") {
      return handleRunList(request, env);
    }

    const runTerminate = /^\/api\/admin\/run\/([A-Za-z0-9_-]{1,128})\/terminate$/.exec(url.pathname);
    if (runTerminate?.[1]) {
      return handleRunTerminate(request, env, runTerminate[1]);
    }

    const runStatus = /^\/api\/admin\/run\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (runStatus?.[1]) {
      return handleRunStatus(request, env, runStatus[1]);
    }

    // ── Phase 9: read API ────────────────────────────────────────────────
    if (url.pathname === "/api/metrics") {
      return handleMetrics(request, env, url);
    }

    if (url.pathname === "/api/narrative") {
      return handleNarrative(request, env, url);
    }

    if (url.pathname === "/api/coverage") {
      return handleCoverage(request, env, url);
    }

    if (url.pathname === "/api/admin/aggregate") {
      return handleAggregate(request, env, url);
    }

    if (url.pathname === "/api/admin/stats") {
      return handleStats(request, env);
    }

    if (url.pathname === "/api/review-queue") {
      return handleReviewQueue(request, env);
    }

    if (url.pathname === "/api/weeks") {
      return handleWeeksList(request, env);
    }

    if (url.pathname === "/api/series") {
      return handleSeries(request, env, url);
    }

    if (url.pathname === "/api/use-case-spaces") {
      return handleUseCaseSpaces(request, env, url);
    }

    if (url.pathname === "/api/insights") {
      return handleInsights(request, env, url);
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found", path: url.pathname }, { status: 404 });
    }

    // Everything else is the dashboard. In production Cloudflare's asset
    // router answers these before the Worker is invoked at all; forwarding
    // explicitly means the same request resolves the same way under `vitest`,
    // where `SELF` addresses the Worker directly and bypasses that router.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Cron fires `30 0 * * 1` — Monday 00:30 UTC, i.e. Monday 06:00 IST. The
    // week to process is the one that just closed, not the one that began 30
    // minutes ago, so step back a week from the trigger instant.
    const weekStart = weekStartIso(new Date(controller.scheduledTime - WEEK_MS));

    await env.WEEKLY_PIPELINE.create({
      // Deterministic id: a duplicate cron delivery collides with the run
      // already in flight instead of starting a second pipeline over the same
      // week.
      id: `weekly-${weekStart}`,
      params: { weekStart, backfillWeeks: 1 },
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * Starts the weekly pipeline on demand.
 *
 * Needed for the initial 12-week backfill, for re-running after a taxonomy
 * change, and for debugging without waiting a week for the cron.
 */
async function handleAdminRun(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  }

  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Parameters come from the query string first, and only then from a JSON
  // body.
  //
  // The body path depends on a content-type header surviving the trip, and
  // three separate runs proved it does not: the Action sent
  // `-H 'content-type: application/json'` and the Worker saw "(none)" every
  // time. Whatever strips it sits between curl and here and is not ours to
  // fix. A query string has no such dependency — the parameters are in the
  // URL, which nothing rewrites.
  //
  // The body is still accepted, because it is the obvious thing to reach for
  // by hand. But a body sent without its content-type is now refused rather
  // than ignored: silently dropping it started runs on the CURRENT week while
  // answering 202, and the only symptom was a week's figures not moving,
  // which reads as a quiet week rather than a wrong one.
  const fromQuery = ["weekStart", "backfillWeeks", "dryRun"].some((k) => url.searchParams.has(k));

  let body: unknown = {};
  if (fromQuery) {
    const q: Record<string, unknown> = {};
    const week = url.searchParams.get("weekStart");
    if (week !== null) q.weekStart = week;

    const weeks = url.searchParams.get("backfillWeeks");
    // Number("") is 0 and Number("x") is NaN; both fail parseRunParams with a
    // message naming the field, which is what we want over a silent default.
    if (weeks !== null) q.backfillWeeks = weeks.trim() === "" ? Number.NaN : Number(weeks);

    const dry = url.searchParams.get("dryRun");
    // Anything that is not exactly true/false stays a string and is rejected,
    // rather than every unrecognised value quietly meaning false.
    if (dry !== null) q.dryRun = dry === "true" ? true : dry === "false" ? false : dry;

    body = q;
  } else {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
    } else if (request.body !== null && request.headers.get("content-length") !== "0") {
      return Response.json(
        {
          error: "unsupported_media_type",
          detail:
            `a request body was sent with content-type "${contentType || "(none)"}". ` +
            "Send the parameters in the query string instead " +
            "(?weekStart=YYYY-MM-DD&backfillWeeks=1), which does not depend on a header.",
        },
        { status: 415 },
      );
    }
  }

  const parsed = parseRunParams(body);
  if ("error" in parsed) {
    return Response.json({ error: "invalid_params", detail: parsed.error }, { status: 400 });
  }

  const instance = await env.WEEKLY_PIPELINE.create({ params: parsed.params });

  // Best-effort, and deliberately not awaited into the failure path: losing
  // the registry row costs observability, while letting it throw would mean a
  // database that has not had 0004 applied cannot start a run at all. The
  // schema probe in /api/admin/stats is what surfaces the missing table.
  try {
    await env.DB
      .prepare(
        `INSERT INTO hf_runs (instance_id, week_start, params, started_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(instance_id) DO NOTHING`,
      )
      .bind(
        instance.id,
        parsed.params.weekStart ?? weekStartIso(new Date()),
        JSON.stringify(parsed.params),
      )
      .run();
  } catch {
    // ignored — see above
  }

  return Response.json(
    { id: instance.id, status: await instance.status(), params: parsed.params },
    { status: 202 },
  );
}

/**
 * Lists recent runs with their live status.
 *
 * The Workflows binding has create() and get(id) but no list, so without the
 * registry a run whose id was lost could only be reached through the
 * Cloudflare dashboard by hand.
 */
async function handleRunList(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let rows: { instance_id: string; week_start: string; started_at: string }[] = [];
  try {
    const q = await env.DB
      .prepare(
        `SELECT instance_id, week_start, started_at FROM hf_runs
         ORDER BY started_at DESC LIMIT 20`,
      )
      .all<{ instance_id: string; week_start: string; started_at: string }>();
    rows = q.results ?? [];
  } catch {
    return Response.json(
      { error: "registry_missing", detail: "apply migrations/0004_run_registry.sql" },
      { status: 503 },
    );
  }

  const runs = await Promise.all(
    rows.map(async (r) => {
      let status: unknown = null;
      try {
        status = await (await env.WEEKLY_PIPELINE.get(r.instance_id)).status();
      } catch {
        // An instance Cloudflare has aged out is reported as such rather than
        // failing the whole listing.
        status = { status: "unknown" };
      }
      return { id: r.instance_id, weekStart: r.week_start, startedAt: r.started_at, status };
    }),
  );

  return Response.json({ runs });
}

/**
 * Stops a run.
 *
 * A wedged instance is the one state that makes a schema migration unsafe —
 * rebuilding a table underneath a live pipeline is exactly what must not
 * happen — and until now the only way to stop one was the Cloudflare
 * dashboard.
 */
async function handleRunTerminate(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  }
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let instance: Awaited<ReturnType<typeof env.WEEKLY_PIPELINE.get>>;
  try {
    instance = await env.WEEKLY_PIPELINE.get(id);
  } catch {
    return Response.json({ error: "not_found", id }, { status: 404 });
  }

  await instance.terminate();
  return Response.json({ id, terminated: true, status: await instance.status() });
}

/**
 * Reports on a pipeline run.
 *
 * Admin-guarded like the trigger: run status names instance ids and step
 * detail, which is operational information rather than dashboard data.
 */
async function handleRunStatus(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const instance = await env.WEEKLY_PIPELINE.get(id);
    return Response.json({ id, status: await instance.status() });
  } catch {
    // `get` throws for an unknown id; that is a 404, not a 500.
    return Response.json({ error: "not_found", id }, { status: 404 });
  }
}

/**
 * Validates the request body by hand.
 *
 * There is no framework doing this for us, and every field here feeds either
 * a rate-limited external walk or a SQL window, so unvalidated input is not
 * a stylistic concern.
 */
export function parseRunParams(
  body: unknown,
): { params: WeeklyPipelineParams } | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }

  const input = body as Record<string, unknown>;
  const params: WeeklyPipelineParams = {};

  const known = new Set(["weekStart", "backfillWeeks", "dryRun"]);
  const unknownKeys = Object.keys(input).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    // Rejecting rather than ignoring: a typo'd `backfill_weeks` that silently
    // did nothing would look like the backfill ran and found little.
    return { error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  if (input.weekStart !== undefined) {
    if (typeof input.weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)) {
      return { error: "weekStart must be an ISO date, YYYY-MM-DD" };
    }
    const parsedDate = new Date(`${input.weekStart}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      return { error: "weekStart is not a real date" };
    }
    if (weekStartIso(parsedDate) !== input.weekStart) {
      return { error: "weekStart must be a Monday" };
    }
    params.weekStart = input.weekStart;
  }

  if (input.backfillWeeks !== undefined) {
    const weeks = input.backfillWeeks;
    if (typeof weeks !== "number" || !Number.isInteger(weeks) || weeks < 1 || weeks > MAX_BACKFILL_WEEKS) {
      return { error: `backfillWeeks must be an integer between 1 and ${MAX_BACKFILL_WEEKS}` };
    }
    params.backfillWeeks = weeks;
  }

  if (input.dryRun !== undefined) {
    if (typeof input.dryRun !== "boolean") {
      return { error: "dryRun must be a boolean" };
    }
    params.dryRun = input.dryRun;
  }

  return { params };
}

// ── Phase 9: read API handlers ──────────────────────────────────────────────

/**
 * Short, revalidated cache.
 *
 * An hour looked reasonable for weekly data and was actively harmful: a
 * browser that loaded the page before the first run finished cached
 * `{"weeks":[]}` and kept showing an empty dashboard for an hour after the
 * data actually landed — with no way for the server to correct it. Week
 * *availability* changes at unpredictable times (a backfill, a re-run, a
 * taxonomy rebuild), so the cheap re-check is worth far more than the saved
 * request.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=60, must-revalidate",
};

/**
 * Upper bound on a series request.
 *
 * Three years. The dashboard groups these weeks into months and quarters, and
 * a quarterly view needs years behind it before it says anything at all — a
 * one-year cap would have left it four columns wide for good. The cap is still
 * here so a hand-typed `weeks=100000` cannot turn one page load into a scan of
 * every metric row the pipeline has ever written.
 */
const MAX_SERIES_WEEKS = 156;

const VALID_CUTS = new Set([
  "spaces_by_use_case",
  "share_by_use_case",
  "vertical_penetration",
  "family_share_by_use_case",
  "technology_penetration",
  "sdk_distribution",
  "models_by_family",
  "engagement",
]);

async function handleMetrics(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const weekStart = url.searchParams.get("week");
  const cut = url.searchParams.get("cut");

  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return Response.json(
      { error: "invalid_params", detail: "week is required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  if (cut && !VALID_CUTS.has(cut)) {
    return Response.json(
      { error: "invalid_params", detail: `unknown cut: ${cut}. Valid: ${[...VALID_CUTS].join(", ")}` },
      { status: 400 },
    );
  }

  const query = cut
    ? `SELECT metric_cut, dimension, sub_dimension, value, denominator, coverage,
              delta_1w, delta_4w, delta_12w, suppressed
       FROM hf_weekly_metrics
       WHERE week_start = ?1 AND taxonomy_version = ?2 AND metric_cut = ?3
       ORDER BY metric_cut, value DESC`
    : `SELECT metric_cut, dimension, sub_dimension, value, denominator, coverage,
              delta_1w, delta_4w, delta_12w, suppressed
       FROM hf_weekly_metrics
       WHERE week_start = ?1 AND taxonomy_version = ?2
       ORDER BY metric_cut, value DESC`;

  const rows = cut
    ? await env.DB.prepare(query).bind(weekStart, TAXONOMY_VERSION, cut).all()
    : await env.DB.prepare(query).bind(weekStart, TAXONOMY_VERSION).all();

  return Response.json(
    { weekStart, taxonomyVersion: TAXONOMY_VERSION, metrics: rows.results ?? [] },
    { headers: CORS_HEADERS },
  );
}

async function handleNarrative(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const weekStart = url.searchParams.get("week");
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return Response.json(
      { error: "invalid_params", detail: "week is required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  // D1 first. The narrative used to live only in the GitHub archive, which
  // meant this endpoint answered `not_found` for every week on record the
  // moment the Worker's token lost `contents: write` — and the dashboard card
  // hides itself on not_found, so a broken feature looked exactly like one
  // that was never built. The archive is still written; it is no longer the
  // only copy.
  const stored = await env.DB.prepare(
    `SELECT narrative FROM hf_insights
      WHERE kind = 'week' AND period_key = ?1 AND taxonomy_version = ?2
        AND status = 'ok' AND narrative <> ''`,
  )
    .bind(weekStart, TAXONOMY_VERSION)
    .first<{ narrative: string }>()
    .catch(() => null);
  if (stored?.narrative) {
    return Response.json({ weekStart, narrative: stored.narrative, source: "database" });
  }

  // Snapshots are committed under their ISO week label (2026-W33), not the
  // Monday date, so the label has to be derived here or every lookup 404s.
  const label = isoWeekLabel(new Date(`${weekStart}T00:00:00.000Z`));
  const path = `data/weeks/${label}.json`;
  try {
    // Authenticated first, for the higher rate limit — then unauthenticated on
    // a credential rejection. GITHUB_REPO is public, so the token buys quota,
    // not access: without the retry an expired PAT would take the dashboard's
    // narrative down for a file anyone on the internet can read. A
    // fine-grained PAT expires on a fixed date, so this is a matter of when.
    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "hf-activity-worker",
    };

    let res = await fetch(url, {
      headers: { ...headers, Authorization: `Bearer ${env.GITHUB_TOKEN}` },
    });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(url, { headers });
    }

    if (!res.ok) {
      return Response.json({ error: "not_found", weekStart }, { status: 404 });
    }

    const data = (await res.json()) as { content: string };
    // Mirror of the publish-side encoding: atob alone yields Latin-1 code
    // units, so any multi-byte character in the narrative or a Space title
    // would come back mojibake.
    const decoded = JSON.parse(decodeBase64Utf8(data.content));
    return Response.json(
      { weekStart, narrative: decoded.narrative ?? null },
      { headers: CORS_HEADERS },
    );
  } catch {
    return Response.json({ error: "not_found", weekStart }, { status: 404 });
  }
}

async function handleCoverage(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const weekStart = url.searchParams.get("week");
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return Response.json(
      { error: "invalid_params", detail: "week is required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  const weekEnd = new Date(
    new Date(`${weekStart}T00:00:00.000Z`).getTime() + 7 * 86_400_000,
  ).toISOString();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM hf_spaces
     WHERE created_at >= ?1 AND created_at < ?2 AND is_cluster_primary = 1`,
  )
    .bind(weekStart, weekEnd)
    .first<{ cnt: number }>();

  const classified = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM hf_spaces s
     JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
     WHERE s.created_at >= ?2 AND s.created_at < ?3
       AND s.is_cluster_primary = 1`,
  )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  // Joined to hf_spaces and bounded by the week. hf_classifications has no
  // week column, so counting it alone returned lifetime totals under a
  // per-week response — the funnel breakdown grew every run and stopped
  // summing to the week's classified figure directly above it.
  const bySource = await env.DB.prepare(
    `SELECT c.source_kind AS kind, COUNT(*) AS cnt
       FROM hf_classifications c
       JOIN hf_spaces s ON s.space_id = c.space_id
      WHERE c.taxonomy_version = ?1
        AND s.created_at >= ?2 AND s.created_at < ?3
        AND s.is_cluster_primary = 1
      GROUP BY c.source_kind`,
  )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ kind: string; cnt: number }>();

  const lowConfidence = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt
       FROM hf_classifications c
       JOIN hf_spaces s ON s.space_id = c.space_id
      WHERE c.taxonomy_version = ?1 AND c.low_confidence = 1
        AND s.created_at >= ?2 AND s.created_at < ?3
        AND s.is_cluster_primary = 1`,
  )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  // Which model produced the LLM half. Restricted to source_kind = 'model'
  // deliberately: rule rows carry their rationale in source_ref, so grouping
  // across both kinds would return thousands of one-row groups.
  const llmModel = await env.DB.prepare(
    `SELECT c.source_ref AS ref, COUNT(*) AS cnt
       FROM hf_classifications c
       JOIN hf_spaces s ON s.space_id = c.space_id
      WHERE c.taxonomy_version = ?1 AND c.source_kind = 'model'
        AND s.created_at >= ?2 AND s.created_at < ?3
        AND s.is_cluster_primary = 1
      GROUP BY c.source_ref
      ORDER BY cnt DESC
      LIMIT 1`,
  )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ ref: string | null; cnt: number }>();

  const sourceCounts = new Map((bySource.results ?? []).map((r) => [r.kind, r.cnt]));

  const totalCount = total?.cnt ?? 0;
  const classifiedCount = classified?.cnt ?? 0;

  return Response.json(
    {
      weekStart,
      totalSpaces: totalCount,
      classifiedSpaces: classifiedCount,
      coveragePercent: totalCount > 0 ? (classifiedCount / totalCount) * 100 : null,
      bySource: {
        rule: sourceCounts.get("rule") ?? 0,
        model: sourceCounts.get("model") ?? 0,
      },
      llmModel: llmModel?.ref ?? null,
      lowConfidence: lowConfidence?.cnt ?? 0,
    },
    { headers: CORS_HEADERS },
  );
}

/**
 * Re-aggregates one week from data already in the database.
 *
 * Aggregation is pure derivation over hf_spaces / hf_classifications and
 * writes only ~120 metric rows, so it can produce a usable dashboard from an
 * ingest that already happened — without re-walking the Hub or re-classifying
 * anything. Useful after a partial run, and after a taxonomy change.
 */
async function handleAggregate(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  }
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const week = url.searchParams.get("week");
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return Response.json({ error: "invalid_params", detail: "week=YYYY-MM-DD required" }, { status: 400 });
  }
  if (weekStartIso(new Date(`${week}T00:00:00.000Z`)) !== week) {
    return Response.json({ error: "invalid_params", detail: "week must be a Monday" }, { status: 400 });
  }

  const weekEnd = new Date(
    new Date(`${week}T00:00:00.000Z`).getTime() + 7 * 86_400_000,
  ).toISOString();

  try {
    const result = await aggregateWeeklyMetrics(env.DB, week, weekEnd);
    return Response.json({ week, ...result });
  } catch (e) {
    // Surfaced rather than swallowed: a D1 daily-limit rejection looks
    // identical to success from the outside otherwise.
    return Response.json(
      { error: "aggregate_failed", detail: String(e).slice(0, 400) },
      { status: 500 },
    );
  }
}

/**
 * Pipeline progress, by table.
 *
 * A Workflow reports only "running" until it returns, which is useless for a
 * run whose slow stages are thousands of sequential README fetches and LLM
 * calls. Row counts per stage show where it actually is.
 */
async function handleStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const one = async (sql: string) =>
    (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

  const [raw, models, spaces, blind, enriched, classified, metrics, weeks] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM hf_raw_records"),
    one("SELECT COUNT(*) AS n FROM hf_models"),
    one("SELECT COUNT(*) AS n FROM hf_spaces"),
    one("SELECT COUNT(*) AS n FROM hf_spaces WHERE signal_tier = 'blind'"),
    one("SELECT COUNT(*) AS n FROM hf_spaces WHERE readme_status IS NOT NULL"),
    one("SELECT COUNT(*) AS n FROM hf_classifications"),
    one("SELECT COUNT(*) AS n FROM hf_weekly_metrics"),
    one("SELECT COUNT(DISTINCT week_start) AS n FROM hf_weekly_metrics"),
  ]);

  const oldest = await env.DB
    .prepare("SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM hf_spaces")
    .first<{ a: string | null; b: string | null }>();

  // Code and schema are deployed by different mechanisms — `git push` ships
  // the Worker, a human runs the migration — so they drift, and the drift is
  // invisible until a write fails deep inside a run. Name the columns a
  // deployed migration should have added and report which are actually there.
  const schema = await missingColumns(env.DB, EXPECTED_COLUMNS);

  return Response.json({
    stage: raw === 0 ? "ingesting (nothing written yet)"
      : spaces === 0 ? "ingesting — raw records landing, not yet parsed"
      : enriched < blind ? `enriching READMEs (${enriched}/${blind} blind Spaces done)`
      : classified === 0 ? "classifying"
      : metrics === 0 ? "aggregating"
      : "complete or idle",
    rawRecords: raw,
    models,
    spaces,
    blindSpaces: blind,
    readmesFetched: enriched,
    classifications: classified,
    metricRows: metrics,
    weeksAggregated: weeks,
    spaceDateRange: { oldest: oldest?.a ?? null, newest: oldest?.b ?? null },
    schema: {
      ok: schema.length === 0,
      missingColumns: schema,
    },
  });
}

/**
 * Columns the deployed code writes that arrived in a migration. Each entry is
 * the migration that adds it; a name appearing in `missingColumns` means that
 * migration has not been applied to this database and writes touching it will
 * fail.
 */
const EXPECTED_COLUMNS: ReadonlyArray<[table: string, column: string]> = [
  ["hf_models", "card_base_model"], // 0002_model_card_base
  ["hf_models", "model_type"],      // 0003_model_config_type (free ADD COLUMN)
  ["hf_runs", "instance_id"],       // 0004_run_registry
];

/**
 * Probes each column with a zero-row SELECT.
 *
 * `PRAGMA table_info` would list them in one query, but D1 returns pragma
 * results in a shape that varies by driver version, and a failed SELECT is
 * unambiguous. The identifiers are compile-time literals from the table
 * above, never request input, so interpolating them is not an injection path.
 */
export async function missingColumns(
  db: D1Database,
  expected: ReadonlyArray<[string, string]>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const [table, column] of expected) {
    try {
      await db.prepare(`SELECT ${column} FROM ${table} LIMIT 0`).all();
    } catch {
      missing.push(`${table}.${column}`);
    }
  }
  return missing;
}

async function handleReviewQueue(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await env.DB.prepare(
    `SELECT c.space_id, c.primary_use_case, c.use_case_confidence,
            c.verticals, c.verticals_confidence,
            c.source_kind, c.rationale,
            s.title, s.short_description
     FROM hf_classifications c
     JOIN hf_spaces s ON s.space_id = c.space_id
     WHERE c.taxonomy_version = ?1
       AND c.low_confidence = 1
       AND c.reviewed = 0
     ORDER BY c.use_case_confidence ASC
     LIMIT 100`,
  )
    .bind(TAXONOMY_VERSION)
    .all();

  return Response.json({ items: rows.results ?? [] });
}

async function handleWeeksList(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const rows = await env.DB.prepare(
    `SELECT DISTINCT week_start FROM hf_weekly_metrics
     WHERE taxonomy_version = ?1
     ORDER BY week_start DESC
     LIMIT 52`,
  )
    .bind(TAXONOMY_VERSION)
    .all<{ week_start: string }>();

  return Response.json(
    { weeks: (rows.results ?? []).map((r) => r.week_start) },
    { headers: CORS_HEADERS },
  );
}

/**
 * Multi-week series for the dashboard's trend lines.
 *
 * `/api/metrics` answers for one week, which is the right shape for a page
 * that shows one week — and the wrong shape for a line that has to keep
 * growing as weeks land. Drawing 26 weeks from it means 26 round trips, and a
 * dashboard that gets slower every week it survives.
 *
 * The response is column-oriented: one entry per (cut, dimension) with its
 * values aligned to a shared `weeks` array. A row per week per dimension
 * repeats the week string and the cut name thousands of times; aligned arrays
 * carry the same information in roughly a third of the bytes, and the client
 * plots them without regrouping.
 *
 * `family_share_by_use_case` is excluded unless asked for by name. It is a
 * cross-tab — every use case times every family — so it alone is more rows
 * than the other seven cuts together, and no line on this page plots it.
 */
const MAX_INSIGHTS = 12;

/**
 * The written insights, newest first.
 *
 * Two kinds, asked for separately or together. Rows whose status is not "ok"
 * are returned too, with their reason: a period the model could not ground its
 * numbers for is a thing the reader should be told about, not a gap in a list.
 */
async function handleInsights(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const kind = url.searchParams.get("kind");
  if (kind !== null && kind !== "week" && kind !== "month") {
    return Response.json(
      { error: "invalid_params", detail: "kind must be week or month" },
      { status: 400 },
    );
  }

  const limitParam = url.searchParams.get("limit");
  let limit = 6;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > MAX_INSIGHTS) {
      return Response.json(
        { error: "invalid_params", detail: `limit must be an integer between 1 and ${MAX_INSIGHTS}` },
        { status: 400 },
      );
    }
    limit = n;
  }

  // Two bounded queries rather than one over-fetch: asking for six of each is
  // not the same as asking for the six most recent overall, which on a weekly
  // cron would be six weeks and no months at all.
  const kinds: Array<"week" | "month"> = kind ? [kind] : ["week", "month"];
  const out: Record<string, unknown[]> = {};
  for (const k of kinds) {
    const rows = await env.DB.prepare(
      `SELECT kind, period_key, week_start, narrative, facts, status, detail,
              model_id, prompt_version, generated_at
         FROM hf_insights
        WHERE kind = ?1 AND taxonomy_version = ?2
        ORDER BY period_key DESC
        LIMIT ?3`,
    )
      .bind(k, TAXONOMY_VERSION, limit)
      .all<{
        kind: string; period_key: string; week_start: string | null;
        narrative: string; facts: string; status: string; detail: string | null;
        model_id: string | null; prompt_version: string | null; generated_at: string;
      }>();

    out[k] = (rows.results ?? []).map((r) => ({
      kind: r.kind,
      periodKey: r.period_key,
      weekStart: r.week_start,
      narrative: r.narrative,
      status: r.status,
      detail: r.detail,
      // The pack the prose was written from, so every figure in it is
      // traceable to the fact it came from. Parsed here rather than shipped as
      // a string, because a caller that has to JSON.parse a field of a JSON
      // response will one day forget to.
      facts: safeParse(r.facts),
      model: r.model_id,
      promptVersion: r.prompt_version,
      generatedAt: r.generated_at,
    }));
  }

  return Response.json({ taxonomyVersion: TAXONOMY_VERSION, ...out });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

const MAX_USE_CASE_SPACES = 50;

/**
 * The Spaces behind one bar of the use-case chart.
 *
 * The chart says 1,140 new Coding Spaces this month. This says which ones —
 * and that is a question the data can only half answer, so the answer is
 * shaped around what is actually true rather than around what was asked for.
 *
 * There is no "most downloaded". `GET /api/spaces?expand[]=downloads` is an
 * HTTP 400: the Hub enumerates its field set for Spaces and downloads is not
 * in it. The trap is that `?sort=downloads` answers 200 and silently ignores
 * the parameter, so a plausible-looking endpoint can be built on a sort that
 * never happened.
 *
 * There is no "most popular" either, not as a reader would hear it. `likes` is
 * frozen at ingest — it is whatever the Space had in the hours after it was
 * created — and of 4,000 sampled Hub Spaces, 95.5% of the 0-7 day cohort have
 * zero likes, the maximum is 28 and the mean is 0.09. Ranking that and calling
 * it popularity would be ranking noise. `trendingScore` is no rescue: 97.0%
 * zero, maximum 24.
 *
 * What it CAN answer honestly is which new Spaces got noticed at all, and how
 * few did. So `likes > 0` is a rule rather than a filter, and the response
 * carries `total` beside `withTraction` so the caller can say "31 of 1,140"
 * instead of presenting a top ten as though it were a leaderboard.
 */
async function handleUseCaseSpaces(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const useCase = url.searchParams.get("useCase");
  if (!useCase || !(USE_CASES as readonly string[]).includes(useCase)) {
    return Response.json(
      { error: "invalid_params", detail: `useCase must be one of: ${USE_CASES.join(", ")}` },
      { status: 400 },
    );
  }

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const isDate = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDate(from) || !isDate(to)) {
    return Response.json(
      { error: "invalid_params", detail: "from and to are required (YYYY-MM-DD, `to` exclusive)" },
      { status: 400 },
    );
  }
  if (from! >= to!) {
    return Response.json(
      { error: "invalid_params", detail: "from must be earlier than to" },
      { status: 400 },
    );
  }

  const limitParam = url.searchParams.get("limit");
  let limit = 20;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > MAX_USE_CASE_SPACES) {
      return Response.json(
        { error: "invalid_params", detail: `limit must be an integer between 1 and ${MAX_USE_CASE_SPACES}` },
        { status: 400 },
      );
    }
    limit = n;
  }

  // Half-open, matching every other window in the pipeline: `to` is the Monday
  // AFTER the last week the caller wants, so a caller can hand over a period's
  // own bounds without arithmetic and without double-counting the boundary.
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T00:00:00.000Z`;

  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN s.likes > 0 THEN 1 ELSE 0 END) AS with_traction,
            SUM(s.likes) AS likes
       FROM hf_classifications c
       JOIN hf_spaces s ON s.space_id = c.space_id
      WHERE c.taxonomy_version = ?1 AND c.primary_use_case = ?2
        AND s.created_at >= ?3 AND s.created_at < ?4
        AND s.is_cluster_primary = 1`,
  )
    .bind(TAXONOMY_VERSION, useCase, fromIso, toIso)
    .first<{ total: number; with_traction: number | null; likes: number | null }>();

  // Ordered so idx_spaces_traction can be walked rather than sorted; space_id
  // last so the order is total and two runs of the same request agree.
  const rows = await env.DB.prepare(
    `SELECT s.space_id, s.title, s.author, s.likes, s.created_at, s.sdk,
            s.short_description, c.low_confidence
       FROM hf_classifications c
       JOIN hf_spaces s ON s.space_id = c.space_id
      WHERE c.taxonomy_version = ?1 AND c.primary_use_case = ?2
        AND s.created_at >= ?3 AND s.created_at < ?4
        AND s.is_cluster_primary = 1 AND s.likes > 0
      ORDER BY s.likes DESC, s.created_at DESC, s.space_id
      LIMIT ?5`,
  )
    .bind(TAXONOMY_VERSION, useCase, fromIso, toIso, limit)
    .all<{
      space_id: string;
      title: string | null;
      author: string | null;
      likes: number;
      created_at: string;
      sdk: string | null;
      short_description: string | null;
      low_confidence: number;
    }>();

  return Response.json(
    {
      useCase,
      from,
      to,
      total: counts?.total ?? 0,
      withTraction: counts?.with_traction ?? 0,
      likes: counts?.likes ?? 0,
      limit,
      spaces: (rows.results ?? []).map((r) => ({
        spaceId: r.space_id,
        title: r.title,
        author: r.author,
        likes: r.likes,
        createdAt: r.created_at,
        sdk: r.sdk,
        description: r.short_description,
        lowConfidence: r.low_confidence === 1,
      })),
    },
  );
}

async function handleSeries(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  // `?cut=` with no value is not a request for a cut named "": it would bind
  // an empty string into the predicate below, match nothing, and answer 200
  // with an empty body that looks exactly like "no data yet".
  const cut = url.searchParams.get("cut") || null;
  if (cut && !VALID_CUTS.has(cut)) {
    return Response.json(
      { error: "invalid_params", detail: `unknown cut: ${cut}. Valid: ${[...VALID_CUTS].join(", ")}` },
      { status: 400 },
    );
  }

  const weeksParam = url.searchParams.get("weeks");
  let weeksWanted = MAX_SERIES_WEEKS;
  if (weeksParam !== null) {
    const n = Number(weeksParam);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SERIES_WEEKS) {
      return Response.json(
        { error: "invalid_params", detail: `weeks must be an integer between 1 and ${MAX_SERIES_WEEKS}` },
        { status: 400 },
      );
    }
    weeksWanted = n;
  }

  // Two queries rather than one window function: D1 is SQLite, and picking the
  // newest N weeks first bounds the second query by a plain indexed range
  // instead of asking it to sort every metric row ever written.
  const weekRows = await env.DB
    .prepare(
      `SELECT DISTINCT week_start FROM hf_weekly_metrics
       WHERE taxonomy_version = ?1
       ORDER BY week_start DESC
       LIMIT ?2`,
    )
    .bind(TAXONOMY_VERSION, weeksWanted)
    .all<{ week_start: string }>();

  // Ascending, because a line is drawn left to right and the client should not
  // have to reverse it before it can plot anything.
  const weeks = (weekRows.results ?? []).map((r) => r.week_start).reverse();
  if (weeks.length === 0) {
    return Response.json(
      { taxonomyVersion: TAXONOMY_VERSION, weeks: [], series: [] },
      { headers: CORS_HEADERS },
    );
  }

  const rows = await env.DB
    .prepare(
      `SELECT week_start, metric_cut, dimension, sub_dimension, value, denominator, suppressed
       FROM hf_weekly_metrics
       WHERE taxonomy_version = ?1
         AND week_start >= ?2
         AND ((?3 IS NULL AND metric_cut <> 'family_share_by_use_case') OR metric_cut = ?3)
       ORDER BY week_start ASC`,
    )
    .bind(TAXONOMY_VERSION, weeks[0], cut)
    .all<SeriesRow>();

  const index = new Map(weeks.map((w, i) => [w, i]));
  const series = new Map<string, SeriesEntry>();

  for (const r of rows.results ?? []) {
    const at = index.get(r.week_start);
    if (at === undefined) continue;

    const sub = r.sub_dimension ?? "";
    const key = `${r.metric_cut}\u0000${r.dimension}\u0000${sub}`;
    let entry = series.get(key);
    if (!entry) {
      // Gaps stay null rather than 0. This endpoint cannot tell the two cases
      // apart on its own: a category with no row in a week that WAS aggregated
      // scored zero, while one in a week that was never computed is unknown.
      // aggregateWeeklyMetrics draws the same distinction for its own growth
      // windows (see the aggregatedWeeks set in lib/aggregate.ts), and the
      // dashboard resolves it the same way — a null means zero only when a
      // sibling series of the same cut has a figure that week. Answering 0
      // here would throw that distinction away before anyone can make it.
      entry = {
        cut: r.metric_cut,
        dimension: r.dimension,
        subDimension: sub,
        values: new Array<number | null>(weeks.length).fill(null),
        denominators: new Array<number | null>(weeks.length).fill(null),
        suppressed: new Array<number>(weeks.length).fill(0),
      };
      series.set(key, entry);
    }

    entry.values[at] = r.value;
    entry.denominators[at] = r.denominator;
    entry.suppressed[at] = r.suppressed ? 1 : 0;
  }

  return Response.json(
    { taxonomyVersion: TAXONOMY_VERSION, weeks, series: [...series.values()] },
    { headers: CORS_HEADERS },
  );
}

interface SeriesRow {
  week_start: string;
  metric_cut: string;
  dimension: string;
  sub_dimension: string | null;
  value: number;
  denominator: number;
  suppressed: number;
}

interface SeriesEntry {
  cut: string;
  dimension: string;
  subDimension: string;
  values: (number | null)[];
  denominators: (number | null)[];
  suppressed: number[];
}
