/**
 * The Worker. It serves a page.
 *
 * It used to do considerably more: it held the weekly pipeline as a Cloudflare
 * Workflow, it ran the cron that started it, and it answered nine read
 * endpoints by querying D1 on every page load. All of that is gone.
 *
 * WHY. Every figure on the dashboard is settled for a week at a time, and none
 * of it was ever specific to the reader — so the read endpoints were a metered
 * database query re-deriving, for each visitor, an answer that had been fixed
 * since Monday. The run writes those answers into `public/data` now and the
 * page fetches files. That removed the reads.
 *
 * The pipeline left for a harder reason. On the free plan a Workflow step gets
 * 10 ms of CPU and an instance gets 1,024 steps, and D1 allows 5 million rows
 * read a day; a single run read 19.5 million. Six runs died this month, each
 * on a different step, each a real bug that was only a bug because of the
 * ceiling. It runs on a GitHub-hosted runner against a SQLite file now — see
 * .github/workflows/weekly-runner.yml and src/runner/.
 *
 * What is left is `/health` and the assets binding, and that is the whole
 * point: nothing here is metered, nothing here can exceed a limit, and a week
 * that fails to publish leaves last week's page intact.
 */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // `deployedAt` is what makes a page attributable. A push and its deploy
      // are minutes apart, and reading the dashboard inside that gap shows the
      // previous version's data with no way to tell. Comparing this against
      // the commit timestamp answers it.
      const version = env.CF_VERSION_METADATA;
      return Response.json({
        status: "ok",
        version: version?.id ?? null,
        deployedAt: version?.timestamp ?? null,
      });
    }

    // Answered explicitly rather than falling through to the page. These paths
    // existed for months and are in bookmarks and in at least one runbook; a
    // caller that gets HTML back learns nothing, and a caller that gets this
    // learns exactly where the data went.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: "gone",
          path: url.pathname,
          detail:
            "The read API was replaced by static files. The same data is under /data — " +
            "see /data/index.json for the weeks available.",
        },
        { status: 410 },
      );
    }

    // Everything else is the dashboard. In production Cloudflare's asset
    // router answers these before the Worker is invoked at all; forwarding
    // explicitly means the same request resolves the same way under `vitest`,
    // where `SELF` addresses the Worker directly and bypasses that router.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
