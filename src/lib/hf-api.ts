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
 * Phase 4 fetches it per-repo, for unresolved records only.
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
    // already make — and it resolves ~11.5% more models than declared lineage
    // alone. Unlike the architecture *tags*, which are derived from it, this
    // is what the model itself says it is.
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
export const MAX_PAGE_SIZE = 1000;

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
      records,
      nextCursor: parseNextCursor(response.headers.get("link")),
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
