import { applyD1Migrations, env } from "cloudflare:test";

// Applied once per test worker, before any suite runs. Every test therefore
// sees the same schema the migration files produce — a schema drift between
// migrations/ and what the tests assume becomes a test failure rather than a
// deploy-time surprise.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
