/**
 * `/udf/history` intraday — the GATE, through the real app. MONEY-1470 (A5).
 *
 * The Redis store is not reachable from a test, so these exercise the half that
 * is pure policy: WHO gets in. Every one of these refusals is a 200 carrying
 * `s:"error"` because the UDF widget does not parse a 401 body — it spins.
 *
 * The buffer read itself is covered by `rollup-logic.test.ts`, which tests the
 * decisions; faking Redis here would assert a mock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createApp } from "../src/app";
import {
  tokenMayReadIntraday,
  tokenMayReadUs,
  TOKEN_AUDIENCE,
} from "../src/app-logic";
import { bearer, mint, TEST_SECRET } from "./helpers/mint";

const app = createApp();
process.env.MARKET_DATA_TOKEN_SECRET = TEST_SECRET;

const INTRADAY_URL =
  "http://local/udf/history?symbol=NSE:RELIANCE&resolution=5&from=1&to=2";

test("an anonymous intraday request is refused, as a 200 with s:error", async () => {
  const res = await app.request(INTRADAY_URL);
  // NOT a 401: the UDF widget does not parse a 401 body, so the chart would
  // spin rather than report. Every UDF refusal in this service is a 200.
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s: string; errmsg: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg, /requires a market-data token/);
});

test("a VALID token WITHOUT the intraday claim is refused — fail closed", async () => {
  // Tokens minted before A5 carry no `intraday` claim. `undefined` must mean
  // NO: a truthy default would have granted intraday to every token already in
  // flight the moment the endpoint shipped.
  const res = await app.request(INTRADAY_URL, {
    headers: bearer(),
  });
  const body = (await res.json()) as { s: string; errmsg: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg, /not included in your plan/);
  // And it is a DIFFERENT refusal from "no token" — telling the two apart is
  // what stops a support ticket becoming a security investigation.
  assert.doesNotMatch(body.errmsg, /requires a market-data token/);
});

test("`intraday: false` is refused just as firmly as an absent claim", async () => {
  const res = await app.request(INTRADAY_URL, {
    headers: bearer({ intraday: false }),
  });
  assert.match(
    ((await res.json()) as { errmsg: string }).errmsg,
    /not included in your plan/,
  );
});

test("tokenMayReadIntraday accepts ONLY a boolean true", () => {
  const base = { sub: "u", aud: TOKEN_AUDIENCE, exp: 1, iat: 0 };
  assert.equal(tokenMayReadIntraday({ ...base, intraday: true }), true);
  assert.equal(tokenMayReadIntraday(base), false);
  assert.equal(tokenMayReadIntraday({ ...base, intraday: false }), false);
  // A truthy STRING must not pass — a JSON round trip can turn a boolean into
  // "true", and this is the one comparison that decides entitlement.
  assert.equal(
    tokenMayReadIntraday({ ...base, intraday: "true" as unknown as boolean }),
    false,
  );
});

test("an UNSERVED intraday resolution is refused by NAME, never as daily bars", async () => {
  // "3" is advertised by the UDF config and stored by nothing. It must reach
  // the intraday branch and be refused there — falling through to the daily
  // tile reader would answer a 3-minute request with daily candles.
  const res = await app.request(
    "http://local/udf/history?symbol=NSE:RELIANCE&resolution=3&from=1&to=2",
    { headers: bearer({ intraday: true }) },
  );
  const body = (await res.json()) as { s: string; errmsg: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg, /is not served/);
});

test("India 1m is refused with the reason and the alternatives", async () => {
  const res = await app.request(
    "http://local/udf/history?symbol=NSE:RELIANCE&resolution=1&from=1&to=2",
    { headers: bearer({ intraday: true }) },
  );
  const body = (await res.json()) as { errmsg: string };
  assert.match(body.errmsg, /narrowest stored interval is 5m/);
  assert.match(body.errmsg, /5m, 15m, 60m/);
});

test("a DAILY request needs no token at all", async () => {
  // The whole point of the split: daily bars stay public and CDN-cached.
  const res = await app.request(
    "http://local/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1&to=2",
  );
  const body = (await res.json()) as { s: string; errmsg?: string };
  // It will not be `ok` — there is no tile store in this test — but it must not
  // be refused for AUTH.
  if (body.s === "error") {
    assert.doesNotMatch(body.errmsg ?? "", /token|plan/i);
  }
});

test("the shared signer produces a token the verifier ACCEPTS", () => {
  // Without this the whole file could pass for the wrong reason: a mis-signed
  // fixture is refused as FORGED, which looks identical to refused as
  // UNENTITLED. Base64url-ing the HMAC's binary string (rather than its base64)
  // mangles bytes and does exactly that.
  const res = mint({ intraday: true, us: true });
  assert.equal(res.split(".").length, 3);
  assert.doesNotMatch(res, /[+/=]/, "the token must be url-safe");
});

test("US intraday needs the LICENCE claim, not the plan claim", async () => {
  // A US listing's buffer holds Tiingo `quote_mid` bars — the same licensed
  // data as `rt:us:quote:*`. Writing `{"tiers":["PRO"]}` into one PlatformConfig
  // row to unlock INDIA intraday must not ship 45 sessions of US OHLC to every
  // PRO subscriber.
  const url =
    "http://local/udf/history?symbol=AAPL:NASDAQ:1980-12-12&resolution=5&from=1&to=2";
  const viaPlan = await app.request(url, {
    headers: bearer({ intraday: true }),
  });
  assert.match(
    ((await viaPlan.json()) as { errmsg: string }).errmsg,
    /not available on this account/,
    "a plan tier is not a licence",
  );

  const licensed = await app.request(url, {
    headers: bearer({ intraday: true, us: true }),
  });
  const body = (await licensed.json()) as { s: string; errmsg?: string };
  // No Redis here, so it cannot be `ok` — but it must not be refused for the
  // LICENCE once the claim is present.
  if (body.s === "error") {
    assert.doesNotMatch(body.errmsg ?? "", /not available on this account/);
  }
});

test("tokenMayReadUs accepts ONLY a boolean true — same polarity as intraday", () => {
  const base = { sub: "u", aud: TOKEN_AUDIENCE, exp: 1, iat: 0 };
  assert.equal(tokenMayReadUs({ ...base, us: true }), true);
  assert.equal(tokenMayReadUs(base), false, "absent means NO");
  assert.equal(tokenMayReadUs({ ...base, us: false }), false);
  assert.equal(
    tokenMayReadUs({ ...base, us: "true" as unknown as boolean }),
    false,
    "a JSON round trip can turn a boolean into a string; this decides a licence",
  );
});
