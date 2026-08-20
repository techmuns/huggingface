import { describe, expect, it } from "vitest";
import { base64Utf8, decodeBase64Utf8,
  commitSnapshot,
} from "../src/lib/snapshot";

describe("snapshot base64", () => {
  it("round-trips ASCII", () => {
    const text = JSON.stringify({ narrative: "Coding Spaces rose 35%." });
    expect(decodeBase64Utf8(base64Utf8(text))).toBe(text);
  });

  it("round-trips the characters a real snapshot actually contains", () => {
    // LLM prose uses em dashes and curly quotes; Hub Space titles are
    // routinely CJK or emoji. btoa() alone throws on every one of these, which
    // would fail the publish step of essentially every real week.
    const text = JSON.stringify({
      narrative: "Qwen's share rose 19% → 28% — driven by agentic tooling.",
      titles: ["通义千问", "AI助手", "🚀 Rocket Chat", "café"],
    });
    expect(decodeBase64Utf8(base64Utf8(text))).toBe(text);
  });

  it("does not throw where btoa would", () => {
    expect(() => btoa("通义千问")).toThrow();
    expect(() => base64Utf8("通义千问")).not.toThrow();
  });

  it("tolerates the line wrapping GitHub applies to its base64", () => {
    const text = "x".repeat(200);
    const wrapped = base64Utf8(text).replace(/(.{60})/g, "$1\n");
    expect(decodeBase64Utf8(wrapped)).toBe(text);
  });

  it("handles a payload larger than one encoding chunk", () => {
    const text = JSON.stringify({ blob: "é通".repeat(30_000) });
    expect(decodeBase64Utf8(base64Utf8(text))).toBe(text);
  });
});

/**
 * A four-hour run — every stage of it correct — was reported as a failure
 * because the archive step got a 403 from an under-scoped GITHUB_TOKEN.
 *
 * The archive is Phase 8. By the time it runs, Phase 7 has already written
 * hf_weekly_metrics and the dashboard is serving the new figures, so a failure
 * here means "the week landed but was not backed up", not "the week failed".
 * A credential expiring must not be able to tell you your pipeline is broken
 * every week for as long as the token stays stale.
 */
describe("a failed archive is reported, not thrown away", () => {
  const payload = {
    weekStart: "2026-08-10",
    weekLabel: "2026-W33",
    taxonomyVersion: "1",
    generatedAt: "2026-08-20T01:00:00.000Z",
    narrative: "n",
    metrics: [],
    coverage: { totalSpaces: 0, classifiedSpaces: 0, coveragePercent: null },
  };

  it("throws on a 403 so the caller can decide what it means", async () => {
    globalThis.fetch = (async () =>
      new Response('{"message":"Resource not accessible by personal access token"}', {
        status: 403,
      })) as unknown as typeof fetch;

    await expect(commitSnapshot(payload, "o/r", "bad-token")).rejects.toThrow(/403/);
  });

  it("carries the reason in the message, not just the status", async () => {
    // The status alone does not tell an operator that the fix is a token
    // scope. The body does, and it is the difference between a five-minute
    // fix and an evening of guessing.
    globalThis.fetch = (async () =>
      new Response('{"message":"Resource not accessible by personal access token"}', {
        status: 403,
      })) as unknown as typeof fetch;

    await expect(commitSnapshot(payload, "o/r", "bad-token"))
      .rejects.toThrow(/not accessible by personal access token/);
  });

  it("reports committed:true only when GitHub actually accepted it", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!init || init.method !== "PUT") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ content: { sha: "abc123" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await commitSnapshot(payload, "o/r", "good-token");
    expect(result.committed).toBe(true);
    expect(result.sha).toBe("abc123");
    expect(result.path).toBe("data/weeks/2026-W33.json");
  });
});
