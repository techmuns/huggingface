import { isAuthorized } from "./lib/auth";
import { weekStartIso } from "./lib/time";
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
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/api/admin/run") {
      return handleAdminRun(request, env);
    }

    const runStatus = /^\/api\/admin\/run\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (runStatus?.[1]) {
      return handleRunStatus(request, env, runStatus[1]);
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      // Phase 9 mounts the read API here. Answering explicitly keeps unknown
      // /api paths from falling through to the dashboard's HTML, which would
      // hand an API caller a 200 and a page instead of a 404 and JSON.
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
async function handleAdminRun(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  }

  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
  }

  const parsed = parseRunParams(body);
  if ("error" in parsed) {
    return Response.json({ error: "invalid_params", detail: parsed.error }, { status: 400 });
  }

  const instance = await env.WEEKLY_PIPELINE.create({ params: parsed.params });
  return Response.json(
    { id: instance.id, status: await instance.status(), params: parsed.params },
    { status: 202 },
  );
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
