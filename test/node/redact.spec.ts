import { describe, expect, it } from "vitest";
import { redactSecretShapes } from "../../src/runner/publish-files";

/**
 * The publisher serialises Space metadata it did not write, and that metadata
 * sometimes quotes a Hugging Face access token verbatim — `hf_` followed by
 * 34 or more url-safe characters. GitHub's push protection then refuses the
 * commit carrying the generated file, which is what stalled the weekly run at
 * the publish step. The token is someone else's published string, not a secret
 * of ours, so the fix is to redact the shape rather than to chase down which
 * matches are live.
 */

const token = (n: number) => `hf_${"a".repeat(n)}`;

describe("redacting secret shapes from published JSON", () => {
  it("redacts a token shape wherever it sits in the payload", () => {
    const json = JSON.stringify({
      space: "owner/demo",
      readme: `Run it with HF_TOKEN=${token(40)} and go.`,
    });

    const out = redactSecretShapes(json);

    expect(out).toContain("hf_[redacted]");
    expect(out).not.toContain(token(40));
    // Still valid JSON, and nothing but the token moved.
    expect(JSON.parse(out).space).toBe("owner/demo");
  });

  it("replaces every occurrence, not just the first", () => {
    const json = JSON.stringify({
      a: token(34),
      b: token(50),
      nested: { c: `prefix ${token(36)} suffix` },
    });

    const out = redactSecretShapes(json);

    // No token shape survives anywhere, and each one became its own marker.
    expect(out).not.toMatch(/hf_[A-Za-z0-9_-]{34,}/);
    expect(out.match(/hf_\[redacted\]/g)).toHaveLength(3);
  });

  it("leaves short or ordinary hf_ strings alone", () => {
    const json = JSON.stringify({
      prefix: "hf_hub",
      handle: "hf_datasets",
      // One character below the 34-character threshold: not a token shape.
      almost: token(33),
    });

    expect(redactSecretShapes(json)).toBe(json);
  });
});
