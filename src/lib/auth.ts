/**
 * Compares two secrets without leaking their contents through timing.
 *
 * A plain `===` on strings short-circuits at the first differing byte, which
 * lets an attacker recover a token one character at a time by measuring
 * response latency. This runs over the full length regardless of where the
 * first mismatch is.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  // Length is not secret in the way the contents are, but comparing unequal
  // lengths byte-wise would read out of bounds, so it is checked first and
  // the loop still runs over a fixed length.
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}

/**
 * Checks a `Authorization: Bearer <token>` header against the admin token.
 *
 * Returns false when the token is unset rather than allowing the request:
 * an unconfigured deployment must fail closed, not open.
 */
export function isAuthorized(request: Request, adminToken: string | undefined): boolean {
  if (!adminToken) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;

  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return false;

  return timingSafeEqual(rest.join(" ").trim(), adminToken);
}
