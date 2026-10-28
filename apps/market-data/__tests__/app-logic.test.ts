/**
 * The market-data service's decisions, tested without a server.
 *
 * Every assertion targets a failure that a running service does not report:
 *
 *   wrong Cache-Control     the CDN caches something private, or caches
 *                           nothing and the service is a slower Vercel
 *                           function with an extra hop. No error either way.
 *   wrong CORS origin       a browser console error nobody sees server-side.
 *   a permissive verifier   an expired or forged token is accepted and
 *                           logs nothing at all.
 *   ready returning 200     a dependency failure reported with the success
 *                           code — the one answer an operator reading this
 *                           endpoint cannot distinguish from health.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  CACHE_CONTROL,
  CORS_ALLOW_METHODS,
  READY_BUDGET_MS,
  TOKEN_AUDIENCE,
  TOKEN_TTL_SECONDS,
  getCorsOrigins,
  readyStatus,
  verifyMarketToken,
} from "../src/app-logic";

const SECRET = "test-secret-not-a-real-key";
const hmac = (data: string, secret: string) =>
  createHmac("sha256", secret).update(data).digest();

function b64url(s: string): string {
  return Buffer.from(s)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mint(
  claims: Record<string, unknown>,
  opts: { alg?: string; secret?: string } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: opts.alg ?? "HS256", typ: "JWT" }),
  );
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${header}.${payload}`)
    .digest()
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.${sig}`;
}

const now = 1_800_000_000;
const valid = () => ({
  sub: "user_1",
  aud: TOKEN_AUDIENCE,
  iat: now,
  exp: now + 300,
});

test("every route sets an explicit Cache-Control, and the 501s are no-store", () => {
  // A missing header means the CDN does not cache, which makes this service a
  // slower Vercel function with an extra network hop — and nothing errors.
  for (const [route, value] of Object.entries(CACHE_CONTROL)) {
    assert.ok(value.length > 0, `${route} has no Cache-Control`);
  }
  assert.equal(CACHE_CONTROL.config, "public, max-age=3600");
  assert.equal(CACHE_CONTROL.time, "public, max-age=1");

  // `s-maxage` only: a browser that cached a symbol resolution for 5 minutes
  // would show a stale name after a rename with no way to refresh.
  assert.ok(CACHE_CONTROL.symbols.includes("s-maxage"));
  assert.ok(
    !/[^-]max-age/.test(CACHE_CONTROL.symbols),
    "symbols must not set a browser max-age",
  );

  // A cached 501 OUTLIVES the deploy that implements the endpoint: A2 would
  // ship and the edge would keep answering "not implemented" until the TTL.
  assert.equal(CACHE_CONTROL.notImplemented, "no-store");
  // A cached health 200 hides an unhealthy instance.
  assert.equal(CACHE_CONTROL.health, "no-store");
});

test("CORS is an allowlist, and production does not trust localhost", () => {
  const prod = getCorsOrigins("production");
  assert.ok(prod.includes("https://usemoney.ai"));
  assert.ok(
    !prod.some((o) => o.includes("localhost")),
    "a production service accepting localhost origins is a CSRF surface dressed as a convenience",
  );
  assert.ok(
    !prod.includes("*"),
    "never a wildcard — these endpoints will carry a bearer token",
  );

  const qa = getCorsOrigins("development");
  assert.ok(
    qa.some((o) => o.includes("localhost")),
    "dev needs localhost",
  );
  assert.ok(qa.includes("https://qa.usemoney.ai"));

  assert.deepEqual(
    [...CORS_ALLOW_METHODS],
    ["GET", "OPTIONS"],
    "this service is read-only",
  );
});

test("the token verifier accepts a well-formed token", () => {
  const v = verifyMarketToken(mint(valid()), SECRET, now, hmac);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.claims.sub, "user_1");
});

test("the verifier refuses expiry, forgery, wrong audience and alg confusion — each with a REASON", () => {
  // A boolean `false` makes "expired", "forged" and "wrong audience" one event
  // in the logs, and they are three different incidents.
  const expired = verifyMarketToken(
    mint({ ...valid(), exp: now - 1 }),
    SECRET,
    now,
    hmac,
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.reason, /expired/);

  const wrongAud = verifyMarketToken(
    mint({ ...valid(), aud: "some-other-service" }),
    SECRET,
    now,
    hmac,
  );
  assert.equal(wrongAud.ok, false);
  if (!wrongAud.ok) assert.match(wrongAud.reason, /audience/);

  const forged = verifyMarketToken(
    mint(valid(), { secret: "attacker-key" }),
    SECRET,
    now,
    hmac,
  );
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.match(forged.reason, /signature/);

  // ALG CONFUSION: `none` must never verify. Trusting the token's own `alg` is
  // the classic JWT forgery.
  const algNone = verifyMarketToken(
    mint(valid(), { alg: "none" }),
    SECRET,
    now,
    hmac,
  );
  assert.equal(algNone.ok, false);
  if (!algNone.ok) assert.match(algNone.reason, /unsupported alg/);

  const rs256 = verifyMarketToken(
    mint(valid(), { alg: "RS256" }),
    SECRET,
    now,
    hmac,
  );
  assert.equal(rs256.ok, false);
});

test("a token whose OWN ttl exceeds policy is refused even while unexpired", () => {
  // It was minted by something that does not share this service's rules, and
  // the only safe reading of that is "not ours". Otherwise lengthening the TTL
  // on the minting side alone would silently widen the window.
  const longLived = mint({ ...valid(), exp: now + TOKEN_TTL_SECONDS + 60 });
  const v = verifyMarketToken(longLived, SECRET, now, hmac);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /ttl exceeds policy/);
});

test("an absent secret refuses every token rather than accepting every token", () => {
  // A fail-open auth check is indistinguishable from a working one until it is
  // exercised by someone who should not have got through.
  const v = verifyMarketToken(mint(valid()), "", now, hmac);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /secret/);
});

test("malformed tokens are refused, not thrown on", () => {
  // A throw here is a 500 for the easiest forgery to write; it must be a 401.
  for (const bad of ["", "a", "a.b", "a.b.c.d", "not-base64.@@@.###"]) {
    const v = verifyMarketToken(bad, SECRET, now, hmac);
    assert.equal(v.ok, false, `"${bad}" must not verify`);
  }
  // A signature of the wrong LENGTH must not reach `timingSafeEqual`, which
  // throws on a length mismatch.
  const short = mint(valid()).split(".").slice(0, 2).join(".") + ".AAAA";
  assert.equal(verifyMarketToken(short, SECRET, now, hmac).ok, false);
});

test("readiness returns 503 on ANY failed dependency, and on none at all", () => {
  // apps/api returns 200 with the dependency marked "unknown". Deliberately not
  // copied: a probe that exists to report a failure must not answer 200.
  assert.equal(readyStatus([{ name: "mongo", ok: true, ms: 1 }]), 200);
  assert.equal(
    readyStatus([
      { name: "mongo", ok: true, ms: 1 },
      { name: "redis", ok: false, ms: 501, detail: "timeout" },
    ]),
    503,
  );
  // NO checks is not health. An empty result means the probe did not run, and
  // `every()` over an empty array is `true` — which would report ready.
  assert.equal(
    readyStatus([]),
    503,
    "an unmeasured dependency is not a healthy one",
  );
});

test("the readiness budget is bounded and small", () => {
  // An unbudgeted probe against a hung Mongo does not fail — it BLOCKS, and
  // whoever is waiting on it waits too. Once the startup probe points here (A2)
  // that is a container killed for not responding rather than a refused
  // revision: a restart loop instead of a deploy that correctly does not land.
  assert.ok(
    READY_BUDGET_MS > 0 && READY_BUDGET_MS <= 1000,
    "per-dependency budget must be sub-second",
  );
});
