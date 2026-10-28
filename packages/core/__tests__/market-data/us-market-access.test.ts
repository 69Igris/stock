/**
 * The US market LICENCE gate (MONEY-1309).
 *
 * Tiingo COMMERCIAL is internal-use-only: ingesting US prices is permitted,
 * serving them to a user is redistribution and needs MONEY-1262. The stock page
 * was already behind the `us-stocks-listing` flag; the three routes that
 * actually serve the prices were behind NOTHING — including `/v1/market/us/quotes`,
 * the mobile endpoint, reachable by any client with a valid Bearer token.
 *
 * These cases pin the rule itself. The per-surface wiring is asserted where it
 * lives; what must hold everywhere is that the DEFAULT is founder-only and that
 * every not-a-string identity is refused.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  isUsMarketAllowed,
  getUsMarketAllowedEmails,
  partitionUsSymbolsByAccess,
} from "../../src/market-data/us-market-access";

const FOUNDER = "deepshaswat@gmail.com";
const saved = process.env.US_MARKET_ALLOWED_EMAILS;

describe("US market access — the default is founder-only", () => {
  beforeEach(() => {
    delete process.env.US_MARKET_ALLOWED_EMAILS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.US_MARKET_ALLOWED_EMAILS;
    else process.env.US_MARKET_ALLOWED_EMAILS = saved;
  });

  it("with nothing configured, ONLY the founder is allowed", () => {
    assert.deepEqual(getUsMarketAllowedEmails(), [FOUNDER]);
    assert.equal(isUsMarketAllowed(FOUNDER), true);
    assert.equal(isUsMarketAllowed("someone.else@example.com"), false);
  });

  it("is case- and whitespace-insensitive on the caller's side", () => {
    // Clerk and our own table do not agree on casing, and an email that
    // round-trips through a JWT can arrive padded. A gate that refuses the
    // founder because of a capital letter would be flipped off in a hurry, by
    // widening it — which is the wrong repair.
    assert.equal(isUsMarketAllowed("  DeepShaswat@Gmail.COM  "), true);
  });

  it("refuses every identity that is not a non-empty string", () => {
    // The absence of an identity is not a permission. `null` is what both
    // surfaces produce when the user lookup fails, so this is the fail-closed
    // path, not a defensive nicety.
    for (const v of [null, undefined, "", "   ", 0, false, {}, []]) {
      assert.equal(
        isUsMarketAllowed(v as unknown as string),
        false,
        `${JSON.stringify(v)} must be refused`,
      );
    }
  });
});

describe("US market access — the env override", () => {
  beforeEach(() => {
    delete process.env.US_MARKET_ALLOWED_EMAILS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.US_MARKET_ALLOWED_EMAILS;
    else process.env.US_MARKET_ALLOWED_EMAILS = saved;
  });

  it("REPLACES the default rather than extending it", () => {
    // Deliberate: an override that always kept the founder would make the list
    // impossible to narrow, and this gate exists to be narrow.
    process.env.US_MARKET_ALLOWED_EMAILS = "qa@example.com";
    assert.deepEqual(getUsMarketAllowedEmails(), ["qa@example.com"]);
    assert.equal(isUsMarketAllowed(FOUNDER), false);
  });

  it("accepts a CSV and normalises each entry", () => {
    process.env.US_MARKET_ALLOWED_EMAILS = " A@x.com , B@x.com ,, ";
    assert.deepEqual(getUsMarketAllowedEmails(), ["a@x.com", "b@x.com"]);
    assert.equal(isUsMarketAllowed("b@X.com"), true);
  });

  it("a blank or all-separator value falls back to the NARROWEST list", () => {
    // Both directions of this matter and only one is obvious. Falling back to
    // the default keeps the founder working; falling back to an EMPTY list
    // would lock everyone out, and falling back to "allow all" would open the
    // gate. A malformed env must never widen it.
    for (const v of ["", "   ", ",,,", " , , "]) {
      process.env.US_MARKET_ALLOWED_EMAILS = v;
      assert.deepEqual(
        getUsMarketAllowedEmails(),
        [FOUNDER],
        `for ${JSON.stringify(v)}`,
      );
      assert.equal(isUsMarketAllowed("anyone@example.com"), false);
    }
  });
});

describe("US market access — refusal is absence, and it is countable", () => {
  beforeEach(() => {
    delete process.env.US_MARKET_ALLOWED_EMAILS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.US_MARKET_ALLOWED_EMAILS;
    else process.env.US_MARKET_ALLOWED_EMAILS = saved;
  });

  it("an allowed caller receives every symbol", () => {
    const p = partitionUsSymbolsByAccess(["AAPL", "NVDA"], FOUNDER);
    assert.deepEqual(p.allowed, ["AAPL", "NVDA"]);
    assert.deepEqual(p.refused, []);
  });

  it("a refused caller receives NONE, and the refusal is enumerated", () => {
    // `refused` exists so the gate's effect can be logged rather than inferred
    // from a short response. A gate whose effect is invisible is one nobody
    // notices has broken.
    const p = partitionUsSymbolsByAccess(["AAPL", "NVDA"], "nope@example.com");
    assert.deepEqual(p.allowed, []);
    assert.deepEqual(p.refused, ["AAPL", "NVDA"]);
  });

  it("does not alias the caller's array", () => {
    const input = ["AAPL"];
    const p = partitionUsSymbolsByAccess(input, FOUNDER);
    p.allowed.push("MUTATED");
    assert.deepEqual(input, ["AAPL"], "the caller's array must not be shared");
  });
});
