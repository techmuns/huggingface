# Hugging Face Developer-Activity Dashboard — Cloudflare Build Plan

> **This document is the original build plan and is now partly historical.**
> It is kept because its measurements and its reasoning are still the record of
> why the schema, the taxonomy and the stage boundaries look the way they do.
> Three of its architectural decisions did not survive contact with the free
> plan, and everything below should be read against these:
>
> | The plan said | What runs now | Why it changed |
> |---|---|---|
> | The weekly pipeline is a Cloudflare Workflow started by a Cron Trigger | `.github/workflows/weekly-runner.yml` runs `src/runner/` as a Node process | A Workflow step gets **10 ms of CPU** on Workers Free. Four step bodies were measured and cut to fit it and runs still died — six times in one month, each on a different step. A GitHub-hosted runner has no CPU limit. |
> | D1 is the single store | A SQLite file, `data/pipeline.sqlite`, carried on the `pipeline-state` orphan branch | D1 Free allows **5 million rows read a day**; one run read 19.5 million. The row caps follow the data, so they arrive again as the data grows. A file has none. |
> | The dashboard reads `GET /api/*`, D1-backed, on the same Worker | The page fetches static files under `/data`, written by the run | Every figure is settled for a week at a time and none of it is per-reader, so those endpoints were a metered query re-deriving a fixed answer for each visitor. |
>
> What did NOT change: the schema in `migrations/`, the taxonomy, the eight
> weekly outputs, the stage sequence, the rate-limit arithmetic, and the
> archive-to-GitHub rule. The pipeline code itself is the same code — it was
> lifted out of the Workflow into `src/pipeline.ts` unchanged, and
> `test/pipeline-run.spec.ts` still drives it against real D1 in workerd so the
> SQLite shim cannot quietly drift from it.
>
> The Worker still exists and still serves the page. It has no database, no
> Workflow, no cron and no secrets — see `wrangler.jsonc`.


## Context

**The ask.** Track **where developer activity is moving** on Hugging Face — explicitly *not* model downloads — along four axes:

| Question | Becomes |
|---|---|
| **What** are developers building? | Primary use case (coding, voice, image gen, doc AI…) |
| **Where** are they building it? | Vertical (healthcare, finance, legal…) |
| **What** are they building **on**? | Model family (Qwen, Llama, DeepSeek…) |
| **How** are they building it? | Technology (RAG, agentic, multimodal, quantized…) |

**The acceptance test.** Two target sentences. If the system can produce these, it is done:

> "Coding agents are +35% over 4 weeks, Qwen's share of new coding Spaces has risen from 19% to 28%, and 60%+ of new coding Spaces are agentic."

> "Healthcare activity is accelerating, driven mainly by Document AI + multimodal applications rather than general chat."

Every field, taxonomy and metric below traces back to those two sentences.

---

## What this repo actually is

The previous plan was written against a mature NestJS/Postgres monolith and leaned on it constantly — copy `super-investors.service.ts`, reuse `LlmModule`, follow the `pg-boss` scheduler, add a row to the `dashboards` table. **None of that exists here.** This repo is:

```
package.json      wrangler 4.123 devDependency, type: module, two scripts
wrangler.jsonc    name: huggingface, main: src/index.js, observability on
src/index.js      12 lines — a /health route and "Hello, World!"
hello_world.py    unrelated
```

No database, no ORM, no HTTP client, no scheduler, no auth, no charting library, no test runner, no CI. Three commits of scaffold.

So this plan is not a migration of the old one. **Every pattern the old plan inherited, this plan has to specify.** That is more work up front and less work later — there is no legacy convention to fight. The compensating advantage: Cloudflare gives us the scheduler (Cron Triggers), the durable pipeline runtime (Workflows), the database (D1), the API host and the static host all as one deploy, with one config file and no servers.

### The two decisions that follow from that

**Storage — D1 as the single store, GitHub as the archive and publication layer.** You offered D1 or JSON-in-GitHub. The measured payload sizes (below) make the choice easy: a full week of raw Hugging Face metadata is **~9.5 MB**, so raw *and* derived *and* aggregates all fit comfortably in one D1 database against its 10 GB ceiling. Using one storage product instead of two is a large simplicity win for a repo that currently has none. GitHub gets the job it is genuinely best at: holding the **published weekly snapshot JSON** — small, diffable, immutable once merged, and free to serve. That combination satisfies the replayability rule without a third product.

**Compute — Cloudflare Workflows, not a bare cron Worker.** The pipeline is five stages that must retry independently, and classification alone will outlive a single Worker invocation. Workflows give durable per-step state, independent step retries, `step.sleep` for rate-limit backoff, and unlimited wall-clock per step. A plain `scheduled()` handler would have to re-run ingest every time classification failed.

---

## The one architectural rule

Carried over unchanged from the previous plan, because it is still the spine:

> *"Retain both the raw source fields and normalized classifications, so we can rerun the taxonomy historically if needed."*

**Raw scraped data is immutable; classifications are a separate, rebuildable layer.**

The taxonomy *will* change — the "Other" bucket always grows until you split it. When it does, you must re-classify all history and regenerate every past week **without re-scraping**. If classification happens in place and the payload is discarded, you can never restate history, and every trend line breaks the moment the taxonomy is touched. Two tables, never one.

On Cloudflare this rule gets a bonus: D1 **Time Travel** gives 30 days of point-in-time recovery on the Workers Paid plan, so an accidental destructive migration is recoverable without touching the archive.

---

## What changed since the last plan — measured today, not recalled

I re-ran the measurements against the live API rather than carrying the old numbers forward. Several moved enough to change decisions.

| Finding | Old plan | Measured now | Consequence |
|---|---|---|---|
| New Spaces / week | ~9,800 | **~6,800** | 30% less classification volume and cost |
| New models / week | ~29,000 | **~25,500** | Unchanged conclusion: ingest is trivial |
| Payload size per record | implied large | **543 B** average, measured over 8,000 records actually ingested | **17.6 MB/week**, not the 9.5 MB estimated. Still single-store D1 territory (26-week retention is ~460 MB against a 10 GB cap), but the retention policy is now load-bearing rather than precautionary |
| `base_model` declared | ~22% | **17.2%** | Coverage reporting is more important, not less |
| Spaces with a linked model | not measured | **26.5%** | Strongest classification signal covers only a quarter |
| Spaces with a short description | not measured | **31.4%** | — |
| Spaces with **neither** | not measured | **58.5%** | **The single most important fact.** Re-measured on a fresh 200-record sample; worse than the 50% first estimated |
| `sdk: static` share of new Spaces | not measured | **56.5%** | Over half of new Spaces are static pages, not apps |
| Spaces carrying a `title` | not measured | **97.5%** | But for the blind half the title is just the slug title-cased (`my-telegram-bot` -> "My Telegram Bot"), so it adds almost nothing beyond the slug itself |
| Template/clone rate | flagged, unquantified | **12.8%** share a normalized title within 24h | Dedup is mandatory and now measurable |

**The finding that reframes the project: roughly half of all new Spaces carry no usable signal beyond their title and slug.** In a single 1,000-record sample, 498 had no linked model, no description, and no meaningful tag. The classifiable universe is about half the raw count — so "new Spaces by use case" is a count over a *resolvable subset*, exactly like model-family resolution, and it needs the same coverage disclosure. Publishing it as an absolute would be the fastest way to lose the stakeholder's trust.

Three consequences:

1. **The repo slug is a primary signal for Spaces, not a last resort.** The old plan ranked name-matching last. But look at what the blind half is actually called: `AI_Resume_Scrnner`, `ai-video-assistant`, `purchase-dashboard`, `inspectflow-pcb-defect-detection`, `summarizer`. When everything else is empty, the slug *is* the description — and it is free, in the listing, for every record.

2. **README fetching flips from "don't" to "conditionally yes."** At 6,800 Spaces/week, the blind subset is ~3,400 — that is ~7 rate-limit windows, about 35 minutes of wall clock, which a Workflow absorbs natively with `step.sleep`. The old plan's 20-hour estimate assumed the higher volume and unconditional fetching. **But gate it hard:** I sampled READMEs from the blind subset and **~58% were the 195-byte auto-generated stub** ("Check out the configuration reference at…"), one was a 404, and only ~33% carried real signal. Fetch them, but discard anything under ~250 bytes or matching the stub, and never re-fetch a Space whose content hash is unchanged.

3. **`sdk: static` at 53% needs a stated position in the methodology.** These are overwhelmingly one-click template duplicates and browser-only demos. They are not noise to be silently dropped — some are real (a browser ONNX PCB-defect detector turned up in the sample) — but a trend line that counts them equally with a Docker-deployed agentic Space is measuring something other than developer activity. Report with and without.

Two API-shape facts that only surfaced on contact with the live endpoint:

- **`title` and `shortDescription` are not expandable on Spaces.** The endpoint rejects them and helpfully enumerates what it does accept. Both live inside `cardData`, as `title` and `short_description`.
- **Cursor pagination re-surfaces records that change mid-walk.** ~0.2% of an 8,000-record ingest arrived twice, each copy carrying a different `lastModified` — genuinely modified between page fetches, not a pagination bug. Append-only raw plus upsert-on-parse absorbs this without special handling, which is a point in favour of the two-layer design rather than a problem to fix.

Also verified unchanged: the API needs **no auth** (a token only raises limits), the rate limit is **500 requests / 5 minutes** anonymous, `limit=1000` works, cursor pagination via the `Link` header works, and `base_model:quantized:Qwen/Qwen3-8B`-style tags come back **directly in the listing** — so family and derivative type are readable without any per-model detail fetch.

---

## Platform constraints that shape the design

Verified against current Cloudflare docs. These are not trivia — each one changes a design decision.

| Limit | Value (Workers Paid) | What it forces |
|---|---|---|
| **Workers Free tier** | 10 ms CPU, 50 subrequests/req, 50 D1 queries/invocation | **Free tier cannot run this.** Workers Paid ($5/mo) is a hard prerequisite. |
| D1 max database size | **10 GB, cannot be raised** | Raw retention policy required (below) |
| D1 queries per invocation | 1,000 | Batch inserts via `db.batch()` — never one query per record |
| D1 max SQL statement | 100 KB (per statement, including inside a batch) | ~200 rows per multi-row INSERT |
| D1 concurrency | Single-threaded per database | Writes are serialized; don't fan out writers |
| Workflow max step result | **1 MiB** | **Steps return counts and keys, never payloads** |
| Workflow steps | 10,000 default, 25,000 configurable | Chunk work; don't create a step per record |
| Workflow subrequests | 10,000 default, up to 10M configurable | Ingest + README + Bedrock fits, but configure it |
| Worker memory | 128 MB | Stream and chunk; never hold a full week in memory |
| Cron Triggers | **UTC only** | The old plan's `Asia/Kolkata` schedule must be converted — Monday 06:00 IST is `30 0 * * 1` |

**Raw retention.** At 9.5 MB/week, raw alone is ~500 MB/year — fine for years against the 10 GB cap, but it grows monotonically alongside everything else. Policy: keep raw in D1 for a rolling 26 weeks; anything older has already been archived to GitHub and is dropped. Replay beyond 26 weeks reads the archive instead. If retention ever needs to be unbounded, R2 is the escape hatch — but on these numbers it is not needed at the start, and adding it early would buy complexity for nothing.

---

## Flow at a glance

```
 HF Hub API
     │
 [1] INGEST ────────► hf_raw_records      (immutable JSON text, append-only, D1)
     │
 [2] PARSE ─────────► hf_models/hf_spaces (typed, queryable, upserted)
     │
 [3] ENRICH ────────► conditional README fetch for the blind subset only
     │
 [4] CLASSIFY ──────► hf_classifications  (labels + confidence + version stamps)
     │                                      rules first, Bedrock for the remainder
 [5] AGGREGATE ─────► hf_weekly_metrics   (precomputed, one row per week × cut)
     │
 [6] NARRATE ───────► weekly Bedrock summary → the two target sentences
     │
 [7] PUBLISH ───────► snapshot JSON committed to GitHub (immutable published week)
     │
 [8] SERVE ─────────► GET /api/* (D1-backed) + static dashboard page, same Worker
```

Stages 1–7 are one weekly Workflow, each step independently re-runnable. Stage 8 is the read path.

---

## Phase 1 — Foundation

**What we do.** Turn the scaffold into a real project before any feature code exists.

- Add a D1 binding and a Workflows binding to `wrangler.jsonc`, plus `assets: { directory: "./public/" }` for the dashboard page and a `triggers.crons` entry.
- Adopt TypeScript. The whole system is data shapes — HF payloads, classification records, metric rows — and this is a greenfield repo, so there is no cost to starting typed and a large cost to retrofitting.
- Add `vitest` + `@cloudflare/vitest-pool-workers` so pipeline logic is testable against a real Workers runtime with a local D1.
- Establish the migration convention: numbered SQL files under `migrations/`, applied with `wrangler d1 migrations apply`.

**Secrets — one live gap to close first.** You said you'll add a `.env` with the AWS Bedrock and Hugging Face keys. Two things matter:

- **`.gitignore` currently ignores `.dev.vars` but not `.env`.** Adding a populated `.env` today would commit your AWS credentials. Fix the ignore file in the first commit.
- Wrangler reads **either** `.dev.vars` **or** `.env` for local dev, not both — if `.dev.vars` exists, `.env` is ignored entirely. Pick one and document it. For deployed environments these are not files at all: each value goes in via `wrangler secret put`. Declare the required names with the `secrets.required` config property so a missing key fails loudly at deploy instead of silently at 3 a.m.

Secrets needed: `HF_TOKEN` (the Hub API is public; a token only raises the rate limit), `BEDROCK_API_KEY`, `GITHUB_TOKEN` (snapshot commits), `ADMIN_TOKEN` (guards the manual trigger).

**Credentials, once supplied, changed two decisions.** Both were verified live against the account rather than assumed:

- The Bedrock credential is a **long-term API key** (`ABSK…`), not an access-key pair. Bedrock API keys authenticate with a plain `Authorization: Bearer` header, so **the SigV4 signer this plan originally specified is not needed at all** — no `aws4fetch`, no request signing, nothing in the Worker bundle beyond `fetch`. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` are all dropped; region becomes a plaintext var.
- **`us-east-1` is the region, and models must be invoked through a regional inference profile.** Both `anthropic.claude-opus-5` and the Haiku 4.5 release are `INFERENCE_PROFILE`-only on this account, so the bare model id returns 400 — the `us.` prefix is required. `ap-south-1` lists Opus 5 but rejects the `apac.` profile for it, and Sonnet 4.6 returns 403 (`INVALID_PAYMENT_INSTRUMENT`) account-wide. **Usable models are Haiku 4.5 and Opus 5 only.**

**Why it matters.** Everything downstream assumes bindings, migrations and a test harness exist. Doing it as one deliberate phase avoids five ad-hoc half-versions of it.

---

## Phase 2 — Data model

**What we do.** Five tables in one initial migration.

| Table | Holds |
|---|---|
| `hf_raw_records` | Every API payload verbatim: entity kind, entity id, fetched-at, ingest run id, full JSON as `TEXT`. Append-only, never updated. |
| `hf_models` | Typed model fields: repo id, author, created/modified, downloads, downloads-all-time, likes, tags, base_model, pipeline_tag, library, plus derived family + derivative type + resolution source |
| `hf_spaces` | Typed Space fields: space id, creator, created/updated, likes, title, short description, tags, sdk, linked models, linked datasets, README text + content hash, dedup cluster id |
| `hf_classifications` | One row per Space per taxonomy version: primary use case, verticals, model families, technologies, confidence per dimension, low-confidence flag, source (rule id vs model+prompt version), taxonomy/prompt/ruleset version stamps |
| `hf_weekly_metrics` | Precomputed weekly aggregates: week start, metric cut, dimension, value, deltas, denominator, coverage |

**SQLite-specific conventions** (D1 is SQLite, so the old plan's Postgres idioms don't transfer): arrays are `TEXT` holding JSON, read with `json_each` when you need to unnest; timestamps are ISO-8601 `TEXT` so lexical sort equals chronological sort; `INTEGER` for booleans; explicit `STRICT` tables to get type enforcement SQLite otherwise lacks.

Index deliberately, because D1 is single-threaded and every aggregation is a scan otherwise: `(created_at)` on both entity tables, `(space_id, taxonomy_version)` unique on classifications, `(week_start, metric_cut)` on metrics, `(entity_kind, entity_id, fetched_at)` on raw.

**Every metric row carries its own denominator and coverage.** Not a nice-to-have — it is the only thing that stops "new Spaces by use case" from being read as an absolute when it is a count over the ~50% that were classifiable at all.

**Why it matters.** This is the raw/derived split made physical, and it is the cheapest phase to get wrong and the most expensive to change later.

---

## Phase 3 — Ingest

> The easiest phase, not the hardest. This is not scraping — it is a documented public REST JSON API with cursor pagination.

**What we do.** Two paginated walks (models, spaces), `sort=createdAt&direction=-1`, `limit=1000`, with the `expand[]` fields the taxonomy needs, following the `Link` header's `rel="next"` cursor until records fall outside the window. Every page is written to `hf_raw_records` **before any parsing**, so a parser bug never costs a re-fetch.

**Volume.** ~26 listing requests/week for models, ~7 for spaces — about **33 requests against a 500-per-5-minute budget**. A 12-week backfill is ~400 requests. Ingestion volume is a non-issue; the interesting engineering is entirely downstream.

**Two field-level traps, both verified:**

- **Never bulk-expand `gguf`.** It embeds the model's entire chat template — hundreds of KB per record. It is useful for one specific fallback in Phase 4, fetched per-repo for unresolved records only, and fatal in a listing of 1,000.
- **Do not fetch per-model detail for `base_model`.** The listing already carries `base_model:<relation>:<target>` tags. This is what keeps ingest at ~33 requests instead of 25,000.

**Cloudflare shape.** One Workflow step per page, returning `{page, cursor, rowsWritten}` — **not the payload**, which would breach the 1 MiB step-result limit at 1,000 records. Writes go through `db.batch()` with multi-row INSERTs of ~200 records, keeping each statement under the 100 KB cap and the whole ingest well under 1,000 queries.

**First run is a 12-week backfill**, so the 4-week and 12-week comparison windows are populated on day one. Without it the dashboard shows nothing meaningful for three months.

**Effort: 1–2 days.** No browser automation, no HTML parsing, no anti-bot handling.

---

## Phase 4 — Normalize models (rules only, no LLM)

**What we do.** Two deterministic derivations over `hf_models`.

**Resolve model family.** Collapse thousands of repo names into Qwen / Llama / DeepSeek / Gemma / Mistral / GLM-Zhipu / Kimi-Moonshot / NVIDIA-Nemotron / other-open / proprietary. The subtlety that matters: **do not pattern-match the repo's own name — resolve `base_model` and inherit from the root.** A repo called `someuser/my-cool-thing-GGUF` whose `base_model` points at a Qwen release *is* a Qwen. Follow the chain transitively with a depth cap and a cycle guard, because a fine-tune of a fine-tune of a Llama is still a Llama.

**Classify derivative type** into base / fine-tune / quantization / adapter / merge / other. Hugging Face gives most of this away in auto-generated tags — verified live, `bartowski/Qwen_Qwen3-8B-GGUF` carries both `base_model:Qwen/Qwen3-8B` and `base_model:quantized:Qwen/Qwen3-8B`, so family *and* relation come straight from the listing.

**Fallback chain, in order:** listing `base_model:<relation>:<target>` tags → `cardData.base_model` → `gguf.architecture` (fetched per-repo for unresolved records only; verified to reveal the family even on bare quant repos with no `base_model`, no `library_name` and no `pipeline_tag`) → repo-name pattern match, last resort, lowest confidence.

**Coverage is a published number, not a footnote.** Measured: **17.2%** of the 1,000 newest models declare `base_model` anywhere — down from the 22% in the previous plan. The remainder are genuine base models, metadata-free repos, and Hub noise. That is acceptable, because the repos that matter for this metric are precisely the ones that declare their lineage — but the dashboard must show resolution coverage beside the family counts.

**Why it matters.** The highest-confidence, lowest-cost part of the system: fully deterministic, zero tokens, no drift. It alone answers one of the eight weekly outputs, and it is the best early milestone to show the stakeholder.

---

## Phase 5 — Enrich the blind half

**What we do.** A step that exists only because of this rewrite's central measurement: ~50% of new Spaces arrive with no description and no linked model.

For that subset only, fetch `https://huggingface.co/spaces/{id}/raw/main/README.md`, then:

- **Discard the stub.** ~58% of blind-subset READMEs are the ~195-byte auto-generated placeholder. Drop anything under ~250 bytes after front-matter stripping, or matching the boilerplate marker. Record the discard so the funnel is visible.
- **Strip YAML front-matter before storing** — it duplicates `cardData` and would dominate a short document's token budget in Phase 6.
- **Hash the content.** Store the hash; never re-fetch or re-classify an unchanged Space.
- **Rate-limit with `step.sleep`.** ~3,400 fetches is ~7 windows, ~35 minutes wall clock — free inside a Workflow, and the reason this is affordable here when it wasn't in the previous plan.

**Dedup runs here too.** Cluster Spaces by normalized title + slug + linked-model set. Measured: **12.8%** of new Spaces share a normalized title with another inside 24 hours, and one template (`firstagenttemplate`) accounted for 20 Spaces in a single day — 2% of that day's total from one viral duplicate. Without clustering, one trending template manufactures a fake "+35% trend". Count clusters, not clones, and state the rule in the methodology.

**Why it matters.** This is the phase that turns ~50% coverage into something closer to ~65%, and it is where the trend line is protected from template noise. Both effects are larger than anything Phase 6 can buy.

---

## Phase 6 — Classify Spaces

The judgement-heavy phase, and the one that decides whether the dashboard is trustworthy. Two passes.

**Pass A — deterministic rules.** Match on tags, SDK, linked models, README keywords, and — new in this plan — **the repo slug**. Linked models remain the strongest single signal: a Space wired to a Whisper checkpoint is Voice/speech; one wired to a diffusion checkpoint is Image generation + Diffusion. The measured tag distribution shows an explicit agentic cluster worth hard-coding (`mcp-server` 41, `agent` 22, `smolagents` 21, `tool` 21, `smolagent` 20, `agent-course` 20 in a 1,000-record sample). These rules are high-precision, free, instant, and stable across reruns.

**Pass B — AWS Bedrock for the remainder.** Only Spaces the rules could not settle — mostly the **vertical** dimension, which is rarely in tags and usually only inferable from prose.

Concrete integration, because there is no existing `LlmModule` to reuse:

- **Authenticate with a bearer token**, not SigV4: `Authorization: Bearer $BEDROCK_API_KEY` against `https://bedrock-runtime.us-east-1.amazonaws.com/model/{modelId}/invoke`. Body carries `anthropic_version: "bedrock-2023-05-31"`. This is a plain `fetch` call with no signing dependency. Do **not** use `@anthropic-ai/bedrock-sdk` — it pulls the full AWS SDK v3 plus `@smithy/eventstream-serde-node`, which is Node-specific and heavy against the Worker's 10 MB script limit.
- **Model: `us.anthropic.claude-haiku-4-5-20251001-v1:0`** for classification. Classification is the only high-volume LLM call in the system, so it takes the cheap model; the once-weekly narrative in Phase 8 keeps `us.anthropic.claude-opus-5`, where the cost is negligible and the prose is what the stakeholder actually reads. Both ids carry the `us.` inference-profile prefix, which is mandatory — the bare `anthropic.` id returns 400 on this account.
- **Structured output** via `output_config.format` — supported on Bedrock — covering all four dimensions plus per-dimension confidence and a one-line rationale. Not the deprecated `output_format`.
- **Batch ~20 Spaces per request** behind a cached taxonomy prompt. This is the main cost lever: it cuts ~3,500 requests/week to ~175.
- **Prompt caching is supported on Bedrock but automatic caching is not** — place `cache_control` breakpoints manually on the taxonomy block, and keep the volatile per-batch content after the last breakpoint.
- **The Message Batches API does not exist on Bedrock**, so the 50% batch discount is unavailable. Cost control comes from the rules-first funnel and request batching instead.

**Cardinality is enforced in the schema, not the UI.** Primary use case is **exactly one** per Space — that is what lets "share of new Spaces by use case" sum to 100%. The other three dimensions are **multi-label**, so their percentages are *penetration rates* and will not sum to 100%. Getting this backwards silently corrupts every chart downstream.

**Confidence and provenance.** A numeric confidence per dimension, a low-confidence boolean under threshold, the source of each label (which rule id, or which model + prompt version), and a review queue for flagged rows.

**Caching.** Key each classification on space id + content hash + prompt version. Re-running the pipeline then costs nothing unless content or prompt actually changed.

**Accuracy measurement.** Hand-label a gold set of ~200–300 Spaces and score per dimension. **Stratify it** — sample separately from the signal-rich half and the blind half, because a gold set drawn only from Spaces with linked models will report an accuracy the live pipeline never achieves.

---

## Phase 7 — Aggregate into the eight weekly outputs

**What we do.** Compute all eight views into `hf_weekly_metrics`.

1. **New Spaces by primary use case** — count created in the week, grouped by the single use-case label.
2. **1W / 4W / 12W growth** — each trailing window against the immediately preceding window of equal length. 4W and 12W exist because 1W is too noisy to read.
3. **Share of new Spaces by use case** — percent of the week's total; sums to 100%. The composition metric, and the one that survives a general surge in Hub volume.
4. **Breakdown by vertical** — multi-label, so reported as penetration, not share.
5. **Model-family share within each major use case** — the cross-tab behind "Qwen's share of new coding Spaces rose 19% → 28%".
6. **Technology penetration and change** — percent agentic / RAG / multimodal, plus WoW delta. Behind "60%+ of new coding Spaces are agentic".
7. **New models built on each major model family** — from Phase 4, no LLM involved.
8. **Download / like trends** — explicitly **secondary** per the brief. Reported, never the headline.

**Every row is written with its denominator and coverage** alongside the value, so the API and the page can render "312 Spaces (of 4,410 classifiable, 65% coverage)" rather than a bare number.

**Precompute rather than query live.** D1 is single-threaded and these are multi-dimensional group-bys over a growing table; the dashboard must not run them per page load.

---

## Phase 8 — Narrate, then publish the week

**Narrate.** Feed the *computed metrics* — never raw rows — to Bedrock and generate the prose summary in the stakeholder's own phrasing, i.e. the two target sentences. Guardrails: suppress or widen the window when the denominator is too small, and never report a percentage change off a tiny base.

**Publish.** Commit a snapshot to GitHub via the contents API: `data/weeks/2026-W33.json` holding that week's metric rows, narrative, coverage figures, and the taxonomy/prompt versions that produced them. This is where the JSON-in-GitHub option earns its place:

- **A published week becomes immutable.** Spaces get deleted and privatised, so re-querying history next month returns different answers than this week's report. The committed snapshot is the answer of record.
- **It is diffable.** A taxonomy change shows up as a reviewable diff across weeks, which is replayability made visible rather than merely possible.
- **It is portable.** If this data ever needs to feed the other product's dashboard library, the snapshot is already a public, versioned, auth-free JSON feed.
- **It is the offsite backup** that makes the 26-week D1 retention policy safe.

Snapshots are tens of KB — nothing like the raw feed, which stays in D1 and never touches git.

---

## Phase 9 — Serve and present

**API.** Routes on the same Worker, reading precomputed rows from D1: weekly metrics by cut, the use-case × family cross-tab, technology penetration, model-family counts, coverage//funnel stats, the low-confidence review queue, and the latest narrative. Public GET for dashboard reads; `ADMIN_TOKEN` bearer guard on the manual trigger and the review queue. Validate query params explicitly — there is no framework doing it for us here.

**Page.** A static page under `public/`, served by the same Worker via the assets binding — same deploy, same domain, no CORS, no second service. Sections mirror the eight outputs: headline KPI strip, new Spaces by use case, growth over three windows, vertical breakdown, model-family share within use case, technology penetration, model-family derivative counts, and downloads/likes last as secondary. A **methodology panel** is not optional: coverage, the dedup rule, the static-Space position, and the taxonomy version all belong on the page, because every headline number is a count over a subset.

Keep the page **iframe-embeddable with clearly named sections** — it costs nothing now and preserves the option of dropping it into the other product's dashboard library later as an `iframe` row, exactly as the previous plan intended.

**Charting.** Nothing is installed. Pick one small library and inline it; the page must load standalone with no parent app auth or styling.

---

## Phase 10 — Schedule it

**What we do.** One weekly Cron Trigger that starts the Workflow. **Cloudflare cron is UTC only** — the previous plan's `Asia/Kolkata` convention has no equivalent, so Monday 06:00 IST becomes `30 0 * * 1`.

Add an admin-guarded `POST` that starts the same Workflow on demand — essential for backfills, for re-running after a taxonomy change, and for debugging without waiting a week. Since the trigger creates a Workflow instance, retries, per-step status and resumption come from the platform rather than from code we write.

---

## Cost

| Item | Estimate |
|---|---|
| Workers Paid | **$5/mo — mandatory**, free tier cannot run this |
| D1 storage | ~500 MB/yr under a 26-week raw retention policy; well inside 10 GB |
| D1 writes | ~65k rows/week ≈ 3.4M/yr ≈ **$3/yr** |
| Bedrock classification | ~175 batched requests/week on Haiku 4.5 ($1/$5 per 1M) with prompt caching — roughly **$2–3/week**. Opus 5 on the same volume would be ~5x that |
| Bedrock narration | 1 request/week on Opus 5 over computed metrics — **cents** |
| GitHub snapshots | free |

**The model split is a measurement, not a guess.** Classification runs on Haiku 4.5 and narration on Opus 5, which puts the cheap model on the ~175 batched requests/week and the strong model on the 1 request/week whose output is read verbatim. The open question is whether Haiku's per-dimension accuracy is good enough, and the stratified gold set from Phase 6 is exactly the instrument for answering it: score both models against it and look at the per-dimension delta. If Haiku holds on use case and technology but slips on vertical — the dimension that most needs prose inference — the answer is to split by dimension rather than to move the whole workload up a tier. Measure once, then pick; don't guess.

---

## Verification

1. **Ingest** — trigger manually with a short window; confirm `hf_raw_records` gains rows and the raw JSON round-trips intact.
2. **Parse** — confirm `hf_models` / `hf_spaces` populate, spot-check records against live Hugging Face pages, confirm re-running upserts rather than duplicating.
3. **Model rules** — verify family inheritance on a quantized repo whose own name reveals nothing (must resolve via `base_model`), and confirm all six derivative types.
4. **Enrichment** — confirm the boilerplate filter rejects the ~195-byte stub, that content hashes prevent re-fetching, and that dedup clusters the known `firstagenttemplate` case.
5. **Classification** — score against the **stratified** gold set per dimension. Confirm primary use case is single-valued and the other three are multi-label. Confirm low-confidence rows reach the review queue.
6. **Aggregation** — confirm use-case shares sum to 100% while technology penetration does not. Recompute one week by hand and match. Confirm every row carries a denominator.
7. **Replayability** — the critical test: bump the taxonomy version, re-classify from `hf_raw_records` with **no network access**, and confirm both versions coexist and historical weeks regenerate under either.
8. **Platform limits** — confirm a full week's ingest stays under 1,000 D1 queries per invocation, that no Workflow step returns more than 1 MiB, and that a killed Workflow resumes without re-running completed steps.
9. **API + page** — confirm validation rejects unknown params, the admin guard rejects unauthenticated calls, and the page renders standalone in an iframe with no parent auth.
10. **Snapshot** — confirm the week commits to GitHub, is byte-identical to what the API serves, and that a later Hub deletion does *not* change the published week.
11. **Narrative** — confirm the summary is factually consistent with the computed metrics, and that small-denominator cuts are suppressed rather than reported as wild percentages.
12. **Schedule** — confirm the cron fires at the right UTC time, a failed step retries, and a re-run is idempotent.

---

## Risks worth knowing up front

- **~50% of new Spaces are unclassifiable from listing metadata.** The headline risk of this rewrite. Mitigated by slug signals and conditional README fetch, disclosed by coverage on every metric — never hidden.
- **53% of new Spaces are `sdk: static`.** Mostly templates and browser demos. Take an explicit position and report with and without.
- **Template/clone volume is 12.8% and spiky.** One viral template produced 2% of a day's Spaces. Dedup is mandatory, and the rule must be stated in the methodology.
- **Downloads are a rolling 30-day figure, not cumulative.** Treat as a rate; never mix with the all-time counter in one trend line. Likes *are* cumulative.
- **"New" needs one definition.** Creation date and first-seen diverge on backfills, renames, and private→public flips. Use creation date as primary but record first-seen so the discrepancy is detectable.
- **Spaces get deleted and privatised**, so history is not re-queryable. This is why published weeks are read from committed snapshots and never recomputed from a fresh pull.
- **`base_model` is messy** — sometimes a string, sometimes a list, sometimes free text, often absent, occasionally pointing at a deleted repo. Hence the depth cap and cycle guard.
- **Multi-label is not share.** The single most common way this class of report gets misread.
- **"Other" is a health metric.** If any dimension's "Other" bucket passes ~15%, the taxonomy needs splitting — which is precisely why replayability is mandatory rather than nice-to-have.
- **Small denominators.** "Healthcare × Video generation" may be four Spaces. Suppress or widen the window below a minimum count instead of publishing a meaningless ±200%.
- **D1's 10 GB ceiling cannot be raised.** Retention policy from day one, not after it hurts.

---

## Sequencing

| Stage | Delivers |
|---|---|
| Phase 1–2 | Bindings, migrations, tests, secrets hygiene, schema. Nothing visible, everything unblocked. |
| Phase 3 | Ingest + 12-week backfill. Raw data in hand; the external dependency is retired. |
| Phase 4 | Model families and derivative types — first real output, fully deterministic, demoable. |
| Phase 5–6 | Enrichment, dedup, classification, stratified gold set. The four answers the brief asked for. |
| Phase 7–8 | The eight weekly views, the narrative, the first published snapshot. |
| Phase 9–10 | API, page, cron. Runs unattended. |

Each stage ends on something showable, so the stakeholder sees progress before the whole thing is finished.
