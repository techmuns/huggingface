import { describe, expect, it } from "vitest";
import { base64Utf8, decodeBase64Utf8 } from "../src/lib/snapshot";

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
