import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentHash,
  dedupSpaces,
  enrichBlindSpaces,
  isBoilerplate,
  normalizeTitle,
  README_MAX_BYTES,
  stripFrontMatter,
  truncateToBytes,
} from "../src/lib/enrich";
import { insertRawRecords } from "../src/lib/raw-store";
import { parseRawSpaces } from "../src/lib/parse";

const DB = env.DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM hf_classifications"),
    DB.prepare("DELETE FROM hf_weekly_metrics"),
    DB.prepare("DELETE FROM hf_spaces"),
    DB.prepare("DELETE FROM hf_models"),
    DB.prepare("DELETE FROM hf_raw_records"),
  ]);
});

// ── stripFrontMatter ────────────────────────────────────────────────────────

describe("stripFrontMatter", () => {
  it("strips YAML front-matter between --- markers", () => {
    const raw = `---
title: My Space
sdk: gradio
---
# Hello World

This is the content.`;
    expect(stripFrontMatter(raw)).toBe("# Hello World\n\nThis is the content.");
  });

  it("returns text unchanged when there is no front-matter", () => {
    const raw = "# Just a README\n\nNo front-matter here.";
    expect(stripFrontMatter(raw)).toBe(raw);
  });

  it("returns text unchanged when there is no closing ---", () => {
    const raw = "---\ntitle: Broken\nNo closing marker";
    expect(stripFrontMatter(raw)).toBe(raw);
  });

  it("handles empty content after front-matter", () => {
    const raw = "---\ntitle: Empty\n---\n";
    expect(stripFrontMatter(raw)).toBe("");
  });
});

// ── isBoilerplate ───────────────────────────────────────────────────────────

describe("isBoilerplate", () => {
  it("flags text shorter than 250 bytes", () => {
    expect(isBoilerplate("Short readme")).toBe(true);
  });

  it("flags text containing the HF stub marker", () => {
    const stub =
      "A".repeat(300) +
      " Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference";
    expect(isBoilerplate(stub)).toBe(true);
  });

  it("passes text that is long enough and has no stub marker", () => {
    const real = "A".repeat(300) + " This is a real README with useful content.";
    expect(isBoilerplate(real)).toBe(false);
  });
});

// ── normalizeTitle ──────────────────────────────────────────────────────────

describe("normalizeTitle", () => {
  it("lowercases and strips non-alphanumeric characters", () => {
    expect(normalizeTitle("My Cool Space!")).toBe("my cool space");
  });

  it("collapses multiple separators into a single space", () => {
    expect(normalizeTitle("hello---world___foo")).toBe("hello world foo");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeTitle("  Spaced  ")).toBe("spaced");
  });

  it("handles empty string", () => {
    expect(normalizeTitle("")).toBe("");
  });
});

// ── contentHash ─────────────────────────────────────────────────────────────

describe("contentHash", () => {
  it("produces a 64-char hex SHA-256 digest", async () => {
    const hash = await contentHash("hello");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same input", async () => {
    const a = await contentHash("test content");
    const b = await contentHash("test content");
    expect(a).toBe(b);
  });

  it("returns different hashes for different input", async () => {
    const a = await contentHash("foo");
    const b = await contentHash("bar");
    expect(a).not.toBe(b);
  });
});

// ── dedupSpaces ─────────────────────────────────────────────────────────────

describe("dedupSpaces", () => {
  async function seedSpaces(
    spaces: Array<{
      id: string;
      title?: string;
      models?: string[];
      createdAt?: string;
    }>,
  ) {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: spaces.map((s) => ({
        id: s.id,
        author: s.id.split("/")[0],
        createdAt: s.createdAt ?? "2026-08-17T12:00:00.000Z",
        lastModified: "2026-08-17T12:00:00.000Z",
        likes: 0,
        sdk: "gradio",
        tags: [],
        models: s.models ?? [],
        datasets: [],
        cardData: { title: s.title ?? s.id.split("/")[1] },
      })),
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");
  }

  it("clusters spaces with the same normalized title", async () => {
    await seedSpaces([
      { id: "a/my-cool-app" },
      { id: "b/my-cool-app" },
      { id: "c/my-cool-app" },
    ]);

    const result = await dedupSpaces(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
    expect(result.clusters).toBe(1);
    expect(result.clustered).toBe(2);

    const primary = await DB.prepare(
      "SELECT COUNT(*) as c FROM hf_spaces WHERE is_cluster_primary = 1",
    ).first<{ c: number }>();
    expect(primary?.c).toBe(1);
  });

  it("does not cluster spaces with different titles", async () => {
    await seedSpaces([
      { id: "a/space-one", title: "Space One" },
      { id: "b/space-two", title: "Space Two" },
    ]);

    const result = await dedupSpaces(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
    expect(result.clusters).toBe(0);
    expect(result.clustered).toBe(0);
  });

  it("considers linked models in clustering", async () => {
    await seedSpaces([
      { id: "a/chatbot", title: "Chatbot", models: ["Qwen/Qwen3-8B"] },
      { id: "b/chatbot", title: "Chatbot", models: ["meta-llama/Llama-3-8B"] },
    ]);

    const result = await dedupSpaces(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
    expect(result.clusters).toBe(0);
  });

  it("returns zero counts for an empty window", async () => {
    const result = await dedupSpaces(DB, "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    expect(result).toEqual({ clustered: 0, clusters: 0 });
  });
});

// ── enrichBlindSpaces ───────────────────────────────────────────────────────

describe("enrichBlindSpaces", () => {
  async function seedBlindSpace(id: string) {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [
        {
          id,
          author: id.split("/")[0],
          createdAt: "2026-08-17T00:00:00.000Z",
          lastModified: "2026-08-17T12:00:00.000Z",
          likes: 0,
          sdk: "gradio",
          tags: [],
          models: [],
          datasets: [],
          cardData: {},
        },
      ],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");
  }

  it("selects only blind spaces with null readme_status", async () => {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [
        {
          id: "rich/space",
          author: "rich",
          createdAt: "2026-08-17T00:00:00.000Z",
          lastModified: "2026-08-17T12:00:00.000Z",
          likes: 0,
          sdk: "gradio",
          tags: [],
          models: [],
          datasets: [],
          cardData: { short_description: "Has a description so it's rich" },
        },
      ],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");

    const result = await enrichBlindSpaces({ db: DB, batchSize: 50 });
    expect(result.total).toBe(0);
  });

  it("returns zero counts when no blind spaces exist", async () => {
    const result = await enrichBlindSpaces({ db: DB, batchSize: 50 });
    expect(result).toMatchObject({ total: 0, fetched: 0 });
  });

  it("serves the newest blind Spaces first", async () => {
    // The queue is global — blind Spaces accumulate across weeks — so the
    // ordering decides whether a run's README budget reaches the week it was
    // started for or gets spent on backlog. Ordered by space_id, "aaa/old"
    // sorts first and the current week's Space is never reached.
    await insertRawRecords(DB, {
      runId: "run-order",
      kind: "space",
      records: [
        {
          id: "aaa/old", author: "aaa",
          createdAt: "2026-07-01T00:00:00.000Z",
          lastModified: "2026-07-01T00:00:00.000Z",
          likes: 0, sdk: "gradio", tags: [], models: [], datasets: [], cardData: {},
        },
        {
          id: "zzz/new", author: "zzz",
          createdAt: "2026-08-17T00:00:00.000Z",
          lastModified: "2026-08-17T00:00:00.000Z",
          likes: 0, sdk: "gradio", tags: [], models: [], datasets: [], cardData: {},
        },
      ],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-order");

    // 404 keeps the test off the network and is a terminal status, so the row
    // leaves the queue exactly as a real fetch would leave it.
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    try {
      const result = await enrichBlindSpaces({ db: DB, batchSize: 1 });
      expect(result.total).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }

    const rows = await DB.prepare(
      "SELECT space_id, readme_status FROM hf_spaces ORDER BY space_id",
    ).all<{ space_id: string; readme_status: string | null }>();

    expect(rows.results).toEqual([
      { space_id: "aaa/old", readme_status: null },
      { space_id: "zzz/new", readme_status: "missing" },
    ]);
  });
});

// ── truncateToBytes ─────────────────────────────────────────────────────────

describe("truncateToBytes", () => {
  const len = (s: string) => new TextEncoder().encode(s).length;

  it("leaves text already inside the budget untouched", () => {
    expect(truncateToBytes("short", 100)).toBe("short");
  });

  it("bounds by bytes, not characters", () => {
    // The reason this is not a .slice(): 40 four-byte emoji is 40 characters
    // but 160 bytes, and a character cap would have let 4x the budget through.
    const emoji = "😀".repeat(40);
    expect(emoji.length).toBe(80);        // code units
    expect(len(emoji)).toBe(160);         // bytes
    const cut = truncateToBytes(emoji, 100);
    expect(len(cut)).toBeLessThanOrEqual(100);
  });

  it("never splits a character in half", () => {
    // Cutting mid-sequence would store a lone surrogate, which is not valid
    // text and breaks anything that later reads the column.
    const cut = truncateToBytes("😀".repeat(10), 7);
    expect(len(cut)).toBeLessThanOrEqual(7);
    expect([...cut].every((c) => c === "😀")).toBe(true);
    expect(cut).toBe("😀");
  });

  it("handles a budget smaller than the first character", () => {
    expect(truncateToBytes("😀abc", 2)).toBe("");
  });

  it("caps a very large README to the documented budget", () => {
    const huge = "a".repeat(README_MAX_BYTES * 3);
    expect(len(truncateToBytes(huge, README_MAX_BYTES))).toBe(README_MAX_BYTES);
  });
});
