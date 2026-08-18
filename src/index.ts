import { weekStartIso } from "./lib/time";

export { WeeklyPipeline } from "./workflow";

const WEEK_MS = 7 * 86_400_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
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
      // already in flight instead of starting a second pipeline over the
      // same week.
      id: `weekly-${weekStart}`,
      params: { weekStart, backfillWeeks: 1 },
    });
  },
} satisfies ExportedHandler<Env>;
