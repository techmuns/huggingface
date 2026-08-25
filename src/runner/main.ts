import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { asD1, openSqliteD1 } from "../lib/d1-sqlite";
import { type PipelineEnv, runWeeklyPipeline } from "../pipeline";
import { applyMigrations } from "./migrate";
import { createRunnerStep, type StepEvent } from "./step";

/**
 * Runs the weekly pipeline in a Node process, against a SQLite file.
 *
 * The same `runWeeklyPipeline` the Worker calls — not a port of it. What
 * changes is only what is handed in: a `PipelineStep` that runs the body and
 * retries it, and a `D1Database` that is a local file rather than a Cloudflare
 * binding.
 *
 * What that buys is the whole reason for this file. There is no 10 ms CPU
 * budget per step, no 1,024-step ceiling per run, no 5-million-rows-a-day read
 * limit, and no 100,000-rows-a-day write limit. Those are properties of the
 * platform the pipeline used to live on, and every one of them has failed a
 * run this month.
 */

interface Args {
  week?: string;
  backfillWeeks: number;
  dbPath: string;
  outPath: string;
  migrationsDir: string;
  dryRun: boolean;
  deadlineMinutes: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEquals) return withEquals.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const week = get("week");
  if (week !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    throw new Error(`--week must be YYYY-MM-DD, got ${week}`);
  }

  const backfill = Number(get("backfill") ?? "1");
  if (!Number.isInteger(backfill) || backfill < 1) {
    throw new Error(`--backfill must be a positive integer, got ${get("backfill")}`);
  }

  const deadline = Number(get("deadline-minutes") ?? "300");
  if (!Number.isFinite(deadline) || deadline <= 0) {
    throw new Error(`--deadline-minutes must be positive, got ${get("deadline-minutes")}`);
  }

  return {
    ...(week === undefined ? {} : { week }),
    backfillWeeks: backfill,
    dbPath: resolve(get("db") ?? "data/pipeline.sqlite"),
    outPath: resolve(get("out") ?? "data/last-run.json"),
    migrationsDir: resolve(get("migrations") ?? "migrations"),
    dryRun: argv.includes("--dry-run"),
    deadlineMinutes: deadline,
  };
}

/**
 * Reads the eight bindings the pipeline needs, and refuses to start without
 * them.
 *
 * Deliberately upfront. A missing Bedrock key surfaces two hours into a run,
 * after ingest and enrich have spent their Hub budget, and looks like a
 * classification failure rather than a configuration one.
 */
function readEnv(source: NodeJS.ProcessEnv): PipelineEnv {
  const required = [
    "HF_TOKEN",
    "BEDROCK_API_KEY",
    "BEDROCK_REGION",
    "BEDROCK_CLASSIFY_MODEL_ID",
    "BEDROCK_NARRATE_MODEL_ID",
    "GITHUB_TOKEN",
    "GITHUB_REPO",
  ] as const;

  const missing = required.filter((k) => !source[k]);
  if (missing.length > 0) {
    throw new Error(
      `missing environment: ${missing.join(", ")}. ` +
        `Set them as repository secrets; never echo their values.`,
    );
  }

  return {
    DB: undefined as unknown as D1Database, // replaced by the caller
    HF_TOKEN: source.HF_TOKEN!,
    BEDROCK_API_KEY: source.BEDROCK_API_KEY!,
    BEDROCK_REGION: source.BEDROCK_REGION!,
    BEDROCK_CLASSIFY_MODEL_ID: source.BEDROCK_CLASSIFY_MODEL_ID!,
    BEDROCK_NARRATE_MODEL_ID: source.BEDROCK_NARRATE_MODEL_ID!,
    GITHUB_TOKEN: source.GITHUB_TOKEN!,
    GITHUB_REPO: source.GITHUB_REPO!,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const env = readEnv(process.env);

  mkdirSync(dirname(args.dbPath), { recursive: true });
  const sqlite = openSqliteD1(args.dbPath);
  env.DB = asD1(sqlite);

  const applied = applyMigrations(sqlite, args.migrationsDir);
  if (applied.length > 0) {
    console.log(`migrations applied: ${applied.join(", ")}`);
  }

  const startedAt = Date.now();
  const deadline = startedAt + args.deadlineMinutes * 60_000;
  const runId = crypto.randomUUID();

  // One line per stage, not per attempt, unless the attempt failed. A run has
  // a few hundred steps and the log is read by a human looking for where it
  // stopped.
  const stages = new Map<string, { attempts: number; ms: number }>();
  const onEvent = (e: StepEvent): void => {
    const key = e.name.replace(/-\d+$/, "-N");
    const seen = stages.get(key) ?? { attempts: 0, ms: 0 };
    stages.set(key, { attempts: seen.attempts + 1, ms: seen.ms + e.ms });
    if (!e.ok) console.warn(`  ! ${e.name} attempt ${e.attempt} failed after ${e.ms}ms: ${e.error}`);
  };

  const step = createRunnerStep({ onEvent, deadline });

  console.log(
    `run ${runId} — week ${args.week ?? "(current)"}, backfill ${args.backfillWeeks}` +
      `${args.dryRun ? ", dry run" : ""}, db ${args.dbPath}`,
  );

  let exitCode = 0;
  let result: unknown;
  let failure: string | undefined;

  try {
    result = await runWeeklyPipeline(step, env, {
      payload: {
        ...(args.week === undefined ? {} : { weekStart: args.week }),
        backfillWeeks: args.backfillWeeks,
        dryRun: args.dryRun,
      },
      timestamp: new Date(startedAt),
      instanceId: runId,
    });
    console.log(`complete in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    exitCode = 1;
    console.error(`FAILED after ${Math.round((Date.now() - startedAt) / 1000)}s: ${failure}`);
  }

  console.log("\nstages:");
  for (const [name, s] of stages) {
    console.log(`  ${name.padEnd(34)} ${String(s.attempts).padStart(4)} x  ${(s.ms / 1000).toFixed(1)}s`);
  }

  // Written whether the run succeeded or not: a failed run's partial summary
  // is the only record of how far it got, and this pipeline has repeatedly
  // been diagnosed from exactly that.
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(
    args.outPath,
    `${JSON.stringify(
      {
        runId,
        week: args.week ?? null,
        backfillWeeks: args.backfillWeeks,
        dryRun: args.dryRun,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        ok: exitCode === 0,
        ...(failure === undefined ? {} : { error: failure }),
        stages: Object.fromEntries([...stages].map(([k, v]) => [k, v])),
        result: result ?? null,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nsummary written to ${args.outPath}`);

  sqlite.close();
  return exitCode;
}

// Only when executed directly, so the module stays importable by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0")) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exit(1);
    },
  );
}
