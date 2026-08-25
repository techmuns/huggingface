import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchReadme } from "../src/lib/enrich";

/**
 * The README fetch was a bare `fetch(url)` for the life of the project — no
 * token, no User-Agent — and two recorded runs enriched 2 of 14,454 and 8 of
 * 14,153 Spaces while reporting themselves complete. README text is the
 * primary signal both classifiers read, so every published classification was
 * made without it.
 *
 * These assertions are about the request that goes out and how the answer is
 * classified, because those are the two things that were wrong.
 */
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function stub(res: Response): { calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push([String(url), init]);
    return Promise.resolve(res);
  }) as typeof fetch;
  return { calls };
}

const headersOf = (init: RequestInit | undefined): Record<string, string> => {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
};

describe("fetchReadme identifies and authenticates itself", () => {
  it("sends the Hub token when it has one", async () => {
    const { calls } = stub(new Response("# hi", { status: 200 }));
    await fetchReadme("u/s", null, "hf_secret");
    expect(headersOf(calls[0]![1]).authorization).toBe("Bearer hf_secret");
  });

  it("always sends a User-Agent, token or not", async () => {
    const { calls } = stub(new Response("# hi", { status: 200 }));
    await fetchReadme("u/s", null);
    const ua = headersOf(calls[0]![1])["user-agent"];
    expect(ua).toBeTruthy();
    expect(ua).toContain("huggingface-activity-dashboard");
    // No token supplied means no Authorization header, not "Bearer undefined".
    expect(headersOf(calls[0]![1]).authorization).toBeUndefined();
  });
});

describe("fetchReadme classifies the answer correctly", () => {
  it("treats 401 and 403 as terminal, not as retry-forever errors", async () => {
    for (const status of [401, 403, 404, 410]) {
      stub(new Response(null, { status }));
      expect((await fetchReadme("u/s", null, "t")).status).toBe("missing");
    }
  });

  it("treats 429 as a rate limit to wait out, never as terminal", async () => {
    stub(new Response(null, { status: 429, headers: { "retry-after": "17" } }));
    const r = await fetchReadme("u/s", null, "t");
    // 'error' is retried by the next run; 'missing' would retire the Space
    // permanently — which is how one rate-limited minute used to shrink the
    // enrichable population for good.
    expect(r.status).toBe("error");
    expect(r.rateLimited).toBe(true);
    expect(r.retryAfterSeconds).toBe(17);
  });

  it("treats 5xx as a transient error, not as missing", async () => {
    stub(new Response(null, { status: 503 }));
    const r = await fetchReadme("u/s", null, "t");
    expect(r.status).toBe("error");
    expect(r.rateLimited).toBeFalsy();
  });
});
