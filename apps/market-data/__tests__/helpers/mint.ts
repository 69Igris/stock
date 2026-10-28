/**
 * Mint a market-data token the way `apps/web/lib/actions/market-data-token.ts`
 * does. Shared by the route tests so there is ONE signer.
 *
 * NOTE the signature is built with `digest("base64")` and then made url-safe.
 * Base64url-ing the digest's BINARY STRING mangles bytes and yields a token
 * that fails verification — which would make every gate test pass for the wrong
 * reason: refused because forged, not because unentitled.
 */
import { createHmac } from "node:crypto";
import { TOKEN_AUDIENCE, TOKEN_TTL_SECONDS } from "../../src/app-logic";

export const TEST_SECRET = "test-market-data-secret";

function b64url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function mint(
  claims: Record<string, unknown> = {},
  secret: string = TEST_SECRET,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: "u1",
      aud: TOKEN_AUDIENCE,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      ...claims,
    }),
  );
  const sig = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.${sig}`;
}

/** `Authorization` header for a token carrying `claims`. */
export function bearer(claims: Record<string, unknown> = {}): {
  Authorization: string;
} {
  return { Authorization: `Bearer ${mint(claims)}` };
}
