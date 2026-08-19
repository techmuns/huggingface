import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { HfApiError, HfClient, MAX_PAGE_SIZE, parseNextCursor } from "../src/lib/hf-api";
import { ingestPage } from "../src/lib/ingest";
import {
  D1_JSON_ARG_MAX_BYTES,
  D1_RECORD_MAX_BYTES,
  chunk,
  chunkByBytes,
  insertRawRecords,
  pruneRawRecords,
} from "../src/lib/raw-store";

const DB = env.DB;

beforeEach(async () => {
  await DB.prepare("delete from hf_raw_records").run();
});

describe("parseNextCursor", () => {
  const cursor = "eyJfaWQiOnsiJGx0IjoiNmE4NDM1NTg5YWRlZjY1Y2ZiYzAyZDM1In19";

  it("extracts the cursor from a real Hub Link header", () => {
    const header = `<https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=1000&cursor=${cursor}>; rel="next"`;
    expect(parseNextCursor(header)).toBe(cursor);
  });

  it("returns null when there is no next page", () => {
    expect(parseNextCursor(null)).toBeNull();
    expect(parseNextCursor("")).toBeNull();
    expect(parseNextCursor('<https://huggingface.co/api/models>; rel="prev"')).toBeNull();
  });

  it("picks the next entry out of a multi-entry header", () => {
    const header = [
      '<https://huggingface.co/api/models?cursor=older>; rel="prev"',
      `<https://huggingface.co/api/models?cursor=${cursor}>; rel="next"`,
    ].join(", ");
    expect(parseNextCursor(header)).toBe(cursor);
  });

  it("returns null rather than throwing on a malformed header", () => {
    expect(parseNextCursor("<not a url>; rel=\"next\"")).toBeNull();
    expect(parseNextCursor("garbage")).toBeNull();
  });
});

describe("HfClient.buildUrl", () => {
  const client = new HfClient();

  it("requests newest-first so a walk can stop at the window edge", () => {
    const url = new URL(client.buildUrl("model"));
    expect(url.searchParams.get("sort")).toBe("createdAt");
    expect(url.searchParams.get("direction")).toBe("-1");
    expect(url.searchParams.get("limit")).toBe(String(MAX_PAGE_SIZE));
  });

  it("never bulk-expands gguf, which would embed whole chat templates", () => {
    expect(client.buildUrl("model")).not.toContain("gguf");
  });

  it("does not request base_model, which arrives inside tags anyway", () => {
    // This is what keeps ingest at ~33 requests instead of ~28,000.
    const expands = new URL(client.buildUrl("model")).searchParams.getAll("expand[]");
    expect(expands).toContain("tags");
    expect(expands).not.toContain("base_model");
  });

  it("requests cardData for Spaces, where title and description actually live", () => {
    // The live API rejects `title` and `shortDescription` as expand fields.
    const expands = new URL(client.buildUrl("space")).searchParams.getAll("expand[]");
    expect(expands).toContain("cardData");
    expect(expands).toContain("models");
    expect(expands).not.toContain("title");
    expect(expands).not.toContain("shortDescription");
  });

  it("passes a cursor through when continuing a walk", () => {
    const url = new URL(client.buildUrl("space", { cursor: "abc123" }));
    expect(url.searchParams.get("cursor")).toBe("abc123");
  });
});

describe("HfApiError", () => {
  it("treats 429 and 5xx as retryable, and other 4xx as not", () => {
    expect(new HfApiError("m", 429).retryable).toBe(true);
    expect(new HfApiError("m", 503).retryable).toBe(true);
    expect(new HfApiError("m", 404).retryable).toBe(false);
    expect(new HfApiError("m", 400).retryable).toBe(false);
  });
});

describe("chunk", () => {
  it("splits evenly and keeps the remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns nothing for an empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("rejects a non-positive size rather than looping forever", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe("insertRawRecords", () => {
  const record = (id: string, createdAt = "2026-08-17T00:00:00.000Z") => ({
    id,
    createdAt,
    tags: ["base_model:quantized:Qwen/Qwen3-8B", "gguf"],
    likes: 3,
  });

  it("stores a page and reports the row count", async () => {
    const written = await insertRawRecords(DB, {
      runId: "run-1",
      kind: "model",
      records: [record("a/one"), record("b/two")],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(written).toBe(2);

    const { results } = await DB.prepare(
      "select entity_kind, entity_id, run_id, fetched_at from hf_raw_records order by entity_id",
    ).all<{ entity_kind: string; entity_id: string; run_id: string; fetched_at: string }>();
    expect(results).toEqual([
      { entity_kind: "model", entity_id: "a/one", run_id: "run-1", fetched_at: "2026-08-18T00:00:00.000Z" },
      { entity_kind: "model", entity_id: "b/two", run_id: "run-1", fetched_at: "2026-08-18T00:00:00.000Z" },
    ]);
  });

  it("preserves each payload's content through the json_each expansion", async () => {
    // The whole raw layer is worthless if the round-trip loses fields, so this
    // asserts the stored payload parses back to exactly the input object.
    const input = {
      id: "bartowski/Qwen_Qwen3-8B-GGUF",
      createdAt: "2026-08-17T00:00:00.000Z",
      cardData: { license: "apache-2.0", nested: { deep: [1, 2, { three: true }] } },
      tags: ["base_model:quantized:Qwen/Qwen3-8B"],
      downloads: 0,
      likes: 0,
    };
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "model",
      records: [input],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });

    const row = await DB.prepare("select payload from hf_raw_records").first<{ payload: string }>();
    expect(JSON.parse(row!.payload)).toEqual(input);
  });

  it("writes a full 1000-record page, which needs more than one chunk", async () => {
    // The point of the json_each strategy: a page this size uses 4 bound
    // parameters per statement, not 5 per record against D1's cap of 100.
    const records = Array.from({ length: 1000 }, (_, i) => record(`author/model-${i}`));
    const written = await insertRawRecords(DB, {
      runId: "run-1",
      kind: "model",
      records,
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(written).toBe(1000);

    const row = await DB.prepare("select count(*) as n from hf_raw_records").first<{ n: number }>();
    expect(row?.n).toBe(1000);
  });

  it("skips records with no id rather than storing something unreplayable", async () => {
    const written = await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [record("a/one"), { createdAt: "2026-08-17T00:00:00.000Z" } as never],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(written).toBe(1);
  });

  it("is a no-op on an empty page", async () => {
    expect(
      await insertRawRecords(DB, {
        runId: "run-1",
        kind: "model",
        records: [],
        fetchedAt: "2026-08-18T00:00:00.000Z",
      }),
    ).toBe(0);
  });

  it("appends on re-ingest instead of replacing, keeping every observation", async () => {
    for (const fetchedAt of ["2026-08-18T00:00:00.000Z", "2026-08-25T00:00:00.000Z"]) {
      await insertRawRecords(DB, { runId: "run-1", kind: "model", records: [record("a/one")], fetchedAt });
    }
    const row = await DB.prepare("select count(*) as n from hf_raw_records").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});

describe("pruneRawRecords", () => {
  it("drops records past the retention horizon and keeps the rest", async () => {
    for (const fetchedAt of ["2026-01-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z"]) {
      await insertRawRecords(DB, {
        runId: "run-1",
        kind: "model",
        records: [{ id: `a/${fetchedAt}` }],
        fetchedAt,
      });
    }
    expect(await pruneRawRecords(DB, "2026-06-01T00:00:00.000Z")).toBe(1);
    const row = await DB.prepare("select count(*) as n from hf_raw_records").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

/** A client that replays canned pages instead of calling the Hub. */
function fakeClient(pages: Array<{ records: Array<{ id: string; createdAt: string }>; nextCursor: string | null }>) {
  const seen: Array<string | null> = [];
  const client = {
    listPage: async (_kind: unknown, options: { cursor?: string | null } = {}) => {
      seen.push(options.cursor ?? null);
      const page = pages.shift();
      if (!page) throw new Error("fake client ran out of pages");
      return page;
    },
  } as unknown as HfClient;
  return { client, seen };
}

describe("ingestPage", () => {
  const params = {
    db: DB,
    kind: "space" as const,
    runId: "run-1",
    since: "2026-08-10T00:00:00.000Z",
    now: new Date("2026-08-18T00:00:00.000Z"),
  };

  it("stores the page and returns counts, never the payload", async () => {
    const { client } = fakeClient([
      {
        records: [
          { id: "a/one", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "b/two", createdAt: "2026-08-16T00:00:00.000Z" },
        ],
        nextCursor: "next-1",
      },
    ]);

    const result = await ingestPage({ ...params, client });
    expect(result).toEqual({
      page: 0,
      nextCursor: "next-1",
      recordsFetched: 2,
      rowsWritten: 2,
      oldestCreatedAt: "2026-08-16T00:00:00.000Z",
      done: false,
    });
    // A step result carrying 1,000 records would breach the 1 MiB cap.
    expect(JSON.stringify(result).length).toBeLessThan(500);
  });

  it("stops once the page reaches past the window", async () => {
    const { client } = fakeClient([
      {
        records: [
          { id: "a/one", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "b/two", createdAt: "2026-08-09T00:00:00.000Z" },
        ],
        nextCursor: "next-1",
      },
    ]);

    const result = await ingestPage({ ...params, client });
    expect(result.done).toBe(true);
    // The straddling page is still stored in full: re-fetching a Space that
    // has since been deleted is not possible, so nothing already paid for is
    // thrown away at ingest time.
    expect(result.rowsWritten).toBe(2);
  });

  it("stops when the listing is exhausted", async () => {
    const { client } = fakeClient([
      { records: [{ id: "a/one", createdAt: "2026-08-17T00:00:00.000Z" }], nextCursor: null },
    ]);
    expect((await ingestPage({ ...params, client })).done).toBe(true);
  });

  it("stops on an empty page", async () => {
    const { client } = fakeClient([{ records: [], nextCursor: "next-1" }]);
    const result = await ingestPage({ ...params, client });
    expect(result).toMatchObject({ done: true, recordsFetched: 0, rowsWritten: 0, oldestCreatedAt: null });
  });

  it("threads the cursor through consecutive pages", async () => {
    const { client, seen } = fakeClient([
      { records: [{ id: "a/one", createdAt: "2026-08-17T00:00:00.000Z" }], nextCursor: "c1" },
      { records: [{ id: "b/two", createdAt: "2026-08-16T00:00:00.000Z" }], nextCursor: "c2" },
    ]);

    const first = await ingestPage({ ...params, client });
    await ingestPage({ ...params, client, cursor: first.nextCursor, page: 1 });

    expect(seen).toEqual([null, "c1"]);
    const row = await DB.prepare("select count(*) as n from hf_raw_records").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it("does not stop early when a page has no usable createdAt", async () => {
    const { client } = fakeClient([
      { records: [{ id: "a/one" } as never], nextCursor: "c1" },
    ]);
    const result = await ingestPage({ ...params, client });
    expect(result.oldestCreatedAt).toBeNull();
    expect(result.done).toBe(false);
  });
});

// ── chunkByBytes ────────────────────────────────────────────────────────────

describe("chunkByBytes", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

  it("keeps every chunk's serialized form under the budget", () => {
    // The regression this pins: chunking by record COUNT produced a 518,088
    // byte argument once `config` joined the model expand list, 5.2x past
    // D1's 100,000 byte statement limit, and ingest died with SQLITE_TOOBIG.
    const records = Array.from({ length: 400 }, (_, i) => ({
      id: `author/model-${i}`,
      config: { model_type: "qwen3_moe", blob: "x".repeat(900) },
    }));

    const { chunks, oversized } = chunkByBytes(records, D1_JSON_ARG_MAX_BYTES, D1_RECORD_MAX_BYTES);

    expect(oversized).toEqual([]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(D1_JSON_ARG_MAX_BYTES);
    }
    expect(chunks.flat()).toHaveLength(400);
  });

  it("adapts to record size rather than assuming it", () => {
    // Same count, 10x the size each: the whole point is that this produces
    // more chunks without anyone re-tuning a constant.
    const small = Array.from({ length: 200 }, (_, i) => ({ id: `s/${i}`, t: "x".repeat(100) }));
    const large = Array.from({ length: 200 }, (_, i) => ({ id: `l/${i}`, t: "x".repeat(1000) }));

    const a = chunkByBytes(small, D1_JSON_ARG_MAX_BYTES, D1_RECORD_MAX_BYTES).chunks.length;
    const b = chunkByBytes(large, D1_JSON_ARG_MAX_BYTES, D1_RECORD_MAX_BYTES).chunks.length;
    expect(b).toBeGreaterThan(a);
  });

  it("separates a record too large to insert at all", () => {
    // One pathological repo must not take the week's ingest with it, and must
    // not vanish silently either — it comes back so the caller can report it.
    const ok = { id: "fine/one", t: "x" };
    const huge = { id: "pathological/one", t: "x".repeat(D1_RECORD_MAX_BYTES + 1) };

    const { chunks, oversized } = chunkByBytes([ok, huge], D1_JSON_ARG_MAX_BYTES, D1_RECORD_MAX_BYTES);
    expect(oversized).toEqual([huge]);
    expect(chunks.flat()).toEqual([ok]);
  });

  it("never emits an empty chunk", () => {
    const { chunks } = chunkByBytes([], D1_JSON_ARG_MAX_BYTES, D1_RECORD_MAX_BYTES);
    expect(chunks).toEqual([]);
  });

  it("puts a single record in its own chunk when it fills the budget", () => {
    const a = { id: "a", t: "x".repeat(60_000) };
    const b = { id: "b", t: "x".repeat(60_000) };
    const { chunks } = chunkByBytes([a, b], D1_JSON_ARG_MAX_BYTES, D1_RECORD_MAX_BYTES);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(bytes(c)).toBeLessThanOrEqual(D1_JSON_ARG_MAX_BYTES);
  });
});
