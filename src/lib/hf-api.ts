/**
 * Hugging Face Hub REST client.
 *
 * This is not scraping. The Hub exposes a documented public JSON API with
 * cursor pagination, so ingest is the easiest phase in the system: roughly 33
 * listing requests covers a full week of both models and Spaces.
 */

export type EntityKind = "model" | "space";

/** One listing entry, as returned by the Hub. Shape varies by `expand[]`. */
export interface HfRecord {
  id: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface HfListPage {
  records: HfRecord[];
  /** Cursor for the following page, or null at the end of the listing. */
  nextCursor: string | null;
}

/**
 * Fields requested per entity kind.
 *
 * `base_model` is deliberately absent from the models list: the listing
 * already carries `base_model:<relation>:<target>` entries inside `tags`, so
 * family and derivative type are both readable without a per-model detail
 * fetch. That single fact is what keeps ingest at ~33 requests rather than
 * ~28,000.
 *
 * `gguf` must never be bulk-expanded. It embeds the model's entire chat
 * template — hundreds of KB per record — and is fatal in a listing of 1,000.
 *
 * `config` IS expanded, but only one field of it survives the response — see
 * `slimConfig` below. We want `config.model_type` and nothing else, and the
 * rest of the object is what nearly cost us the models it was there to find.
 */
const EXPAND: Record<EntityKind, readonly string[]> = {
  model: [
    "author",
    "createdAt",
    "lastModified",
    "downloads",
    "downloadsAllTime",
    "likes",
    "tags",
    "pipeline_tag",
    "library_name",
    "cardData",
    // The canonical architecture field. Free — it rides the listing request we
    // already make — and it is what the model itself says it is, rather than
    // what its title suggests. Trimmed to `model_type` on arrival.
    "config",
  ],
  // Verified against the live API: `title` and `shortDescription` are NOT
  // expandable on Spaces — the endpoint rejects them and enumerates what it
  // accepts. Both live inside `cardData` as `title` and `short_description`.
  space: [
    "author",
    "createdAt",
    "lastModified",
    "likes",
    "tags",
    "sdk",
    "models",
    "datasets",
    "cardData",
    "runtime",
  ],
};

const ENDPOINT: Record<EntityKind, string> = {
  model: "https://huggingface.co/api/models",
  space: "https://huggingface.co/api/spaces",
};

/** Verified to be accepted by both endpoints. */
/**
 * Records fetched per listing request, and therefore per ingest step.
 *
 * Sized against CPU, not against the Hub. The Hub is happy to return 1,000 and
 * did for months; what it costs is the problem. An ingest step serializes
 * every record it fetches — once in chunkByBytes to measure it, once more at
 * the bind — and on Workers Free a step gets **10 ms of CPU**. Measured on
 * realistic model records with `config` expanded:
 *
 *     1,000 a page   7.8 ms   at the ceiling, nothing left for replay
 *       500 a page   3.6 ms
 *       400 a page   2.8 ms
 *
 * A run died at `ingest-model-page-41` with "Worker exceeded CPU time limit",
 * six attempts, the fastest failing in 178 ms — a step that never got going,
 * not a slow one.
 *
 * 400 leaves roughly three quarters of the budget for orchestration replay and
 * for production being slower than a benchmark on a laptop. Total CPU across
 * the walk barely moves (~292 ms either way) — the same work is simply spread
 * over more, smaller steps, which is the only shape that fits.
 *
 * Cost in steps: the deepest walk observed was 41,000 records, which is 103
 * pages here against STEP_BUDGET.ingestPerWalk of 150. Raising this back up
 * without re-measuring is how the CPU ceiling gets hit again.
 */
export const MAX_PAGE_SIZE = 400;

export class HfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds the Hub asked us to wait, when it said so. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "HfApiError";
  }

  /** Transient conditions worth retrying; 4xx other than 429 is not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * Extracts the `cursor` query parameter from the `rel="next"` entry of a
 * `Link` header, or null when the listing is exhausted.
 *
 * The cursor is pulled out rather than the whole URL because it travels
 * between Workflow steps, where results are capped at 1 MiB and every value
 * kept small is one less thing to think about.
 */
export function parseNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const entry of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(entry.trim());
    if (!match?.[1]) continue;
    try {
      return new URL(match[1]).searchParams.get("cursor");
    } catch {
      return null;
    }
  }
  return null;
}

export interface ListPageOptions {
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export class HfClient {
  /**
   * @param token Optional. The Hub API is public and needs no auth; a token
   *   only raises the anonymous 500-requests-per-5-minutes rate limit.
   */
  constructor(private readonly token?: string) {}

  buildUrl(kind: EntityKind, options: ListPageOptions = {}): string {
    const url = new URL(ENDPOINT[kind]);
    // Newest first, so a walk can stop as soon as it reaches records older
    // than the window instead of paging to the end of the Hub.
    url.searchParams.set("sort", "createdAt");
    url.searchParams.set("direction", "-1");
    url.searchParams.set("limit", String(options.limit ?? MAX_PAGE_SIZE));
    for (const field of EXPAND[kind]) {
      url.searchParams.append("expand[]", field);
    }
    if (options.cursor) {
      url.searchParams.set("cursor", options.cursor);
    }
    return url.toString();
  }

  async listPage(kind: EntityKind, options: ListPageOptions = {}): Promise<HfListPage> {
    const headers: HeadersInit = { accept: "application/json" };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(this.buildUrl(kind, options), {
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new HfApiError(
        `Hugging Face ${kind} listing failed: ${response.status} ${await safeText(response)}`,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }

    const records = (await response.json()) as HfRecord[];
    if (!Array.isArray(records)) {
      throw new HfApiError(`Hugging Face ${kind} listing returned a non-array body`, 200);
    }

    return {
      records: kind === "model" ? records.map(slimConfig) : records,
      nextCursor: parseNextCursor(response.headers.get("link")),
    };
  }
}

/**
 * Keeps `config.model_type` and throws the rest of the config away.
 *
 * The whole config object is enormous and almost entirely useless to us. A
 * quantized flagship carries a per-layer quantization block: measured over
 * 12,000 models, the mean record is 4,507 bytes and the largest is 2.38 MB
 * (`Karmation/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4`), and **17 of them
 * exceed the 90,000-byte ceiling in `chunkByBytes` and are silently
 * DISCARDED** with a console warning. Those 17 are precisely the models that
 * would resolve to a named family — the NVFP4 and GPTQ builds of Nemotron,
 * DeepSeek, Qwen3-Coder — and they never reach the table at all.
 *
 * Trimming here rather than dropping the expand entirely is what keeps the
 * signal: `model_type` is the field the resolver reads, and it is 20-odd bytes
 * of a 4,000-byte object. Mean record 4,507 -> ~490 bytes, largest 2.38 MB ->
 * ~40 KB, records over the ceiling 17 -> 0.
 *
 * This is the ingest boundary, so everything downstream — the raw store, the
 * byte chunker, the upsert — sees the trimmed record and nothing has to know.
 */
function slimConfig(record: HfRecord): HfRecord {
  const config = (record as { config?: unknown }).config;
  if (config == null || typeof config !== "object") return record;
  const modelType = (config as { model_type?: unknown }).model_type;
  return {
    ...record,
    config: typeof modelType === "string" ? { model_type: modelType } : {},
  } as HfRecord;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
