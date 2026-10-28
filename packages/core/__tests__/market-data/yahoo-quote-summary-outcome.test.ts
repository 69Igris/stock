/**
 * MONEY-1238 (#7) — `fetchQuoteSummary`'s `null` was THREE answers in a coat.
 *
 * The function catches every error and returns `null`, so "Yahoo 500ed /
 * timed out / blocked our egress" arrived as the same value as "this ETF has
 * no assetProfile". That is survivable for a render — both mean "no number to
 * draw" — and fatal for a WRITER: sector-enrichment turned the null into a
 * permanent `"N/A"` sentinel and reported `failed=0`.
 *
 * `fetchQuoteSummaryOutcome` is the real implementation now and keeps the
 * distinction; `fetchQuoteSummary` is a lossy adapter over it, so all ~15
 * existing callers are byte-identical. This file pins BOTH halves against a
 * mocked Yahoo — the split, and the adapter's backwards compatibility.
 *
 * Separate file on purpose: the auth cache in yahoo-api.ts is module-global,
 * and `node --test` gives each FILE its own process.
 *
 * Source: packages/core/src/market-data/yahoo-api.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchQuoteSummary,
  fetchQuoteSummaryOutcome,
} from "../../src/market-data/yahoo-api";
import { installMockAgent, stubYahooAuth } from "../_contracts/mock-agent";

const YAHOO = "https://query2.finance.yahoo.com";
const SUMMARY_PATH = /^\/v10\/finance\/quoteSummary\//;

/**
 * Shrinks the retry ladder from 1s/2s/4s to 1ms/2ms/4ms. Every attempt and
 * every branch still runs — only the waiting is scaled — which matters because
 * `--test-timeout` is 30s of WALL CLOCK and a 403/5xx exhausts MAX_RETRIES.
 */
const FAST = { backoffBaseMs: 1 };

async function withYahoo<T>(
  reply: { statusCode: number; body: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  const mock = installMockAgent();
  try {
    stubYahooAuth(mock);
    mock.interceptJson({
      origin: YAHOO,
      path: SUMMARY_PATH,
      method: "GET",
      statusCode: reply.statusCode,
      body: reply.body,
      persist: true,
    });
    return await fn();
  } finally {
    await mock.close();
  }
}

const PROFILE_BODY = {
  quoteSummary: {
    result: [{ assetProfile: { sector: "Realty", industry: "REIT" } }],
  },
};

describe("fetchQuoteSummaryOutcome separates absence from unavailability", () => {
  it("200 with a result is `ok` and carries the module data", async () => {
    const outcome = await withYahoo(
      { statusCode: 200, body: PROFILE_BODY },
      () => fetchQuoteSummaryOutcome("DLF.NS", ["assetProfile"], FAST),
    );
    assert.equal(outcome.kind, "ok");
    assert.deepEqual(outcome.kind === "ok" ? outcome.data.assetProfile : null, {
      sector: "Realty",
      industry: "REIT",
    });
  });

  it("200 with an EMPTY result is `empty/no-result` — Yahoo's own answer", async () => {
    const outcome = await withYahoo(
      { statusCode: 200, body: { quoteSummary: { result: [] } } },
      () => fetchQuoteSummaryOutcome("NIFTYBEES.NS", ["assetProfile"], FAST),
    );
    assert.equal(outcome.kind, "empty");
    assert.equal(outcome.kind === "empty" ? outcome.reason : null, "no-result");
  });

  it("404 is `empty/not-found` — deterministic, and safe to write down", async () => {
    const outcome = await withYahoo(
      { statusCode: 404, body: { finance: { error: "Not Found" } } },
      () => fetchQuoteSummaryOutcome("NOSUCH.NS", ["assetProfile"], FAST),
    );
    assert.equal(outcome.kind, "empty");
    assert.equal(outcome.kind === "empty" ? outcome.reason : null, "not-found");
  });

  it("503 is `unavailable` and carries the status — NEVER `empty`", async () => {
    const outcome = await withYahoo({ statusCode: 503, body: {} }, () =>
      fetchQuoteSummaryOutcome("DLF.NS", ["assetProfile"], FAST),
    );
    assert.equal(outcome.kind, "unavailable");
    assert.equal(outcome.kind === "unavailable" ? outcome.status : null, 503);
  });

  it("403 — an EGRESS BLOCK — is `unavailable`, not a fact about the symbol", async () => {
    // This is the exact failure that silently killed the Tickertape feed for
    // five months: 200 from a laptop, 403 from our production egress.
    // Recording it as "this symbol has no sector" is how it stays invisible.
    const outcome = await withYahoo({ statusCode: 403, body: {} }, () =>
      fetchQuoteSummaryOutcome("DLF.NS", ["assetProfile"], FAST),
    );
    assert.equal(outcome.kind, "unavailable");
    assert.equal(outcome.kind === "unavailable" ? outcome.status : null, 403);
  });

  it("429 is `unavailable` — a rate limit says nothing about the symbol", async () => {
    const outcome = await withYahoo({ statusCode: 429, body: {} }, () =>
      fetchQuoteSummaryOutcome("DLF.NS", ["assetProfile"], FAST),
    );
    assert.equal(outcome.kind, "unavailable");
  });

  it("an unfetchable symbol is `empty/unfetchable-symbol` with NO request", async () => {
    const mock = installMockAgent();
    try {
      stubYahooAuth(mock);
      const seen = mock.interceptJson({
        origin: YAHOO,
        path: SUMMARY_PATH,
        method: "GET",
        statusCode: 200,
        body: PROFILE_BODY,
        persist: true,
      });
      const outcome = await fetchQuoteSummaryOutcome(
        "1018GS2026.NS",
        ["assetProfile"],
        FAST,
      );
      assert.equal(outcome.kind, "empty");
      assert.equal(
        outcome.kind === "empty" ? outcome.reason : null,
        "unfetchable-symbol",
      );
      assert.equal(seen.calls.length, 0, "a request was made anyway");
    } finally {
      await mock.close();
    }
  });
});

describe("fetchQuoteSummary keeps its old lossy contract for existing callers", () => {
  it("returns the data on ok", async () => {
    const r = await withYahoo({ statusCode: 200, body: PROFILE_BODY }, () =>
      fetchQuoteSummary("DLF.NS", ["assetProfile"], FAST),
    );
    assert.deepEqual(r?.assetProfile, { sector: "Realty", industry: "REIT" });
  });

  it("collapses BOTH empty and unavailable back to null", async () => {
    // The ~15 callers outside this fix must not change behaviour. That is why
    // the three-state function is additive rather than a widened signature.
    for (const status of [404, 503, 403, 429]) {
      assert.equal(
        await withYahoo({ statusCode: status, body: {} }, () =>
          fetchQuoteSummary("DLF.NS", ["assetProfile"], FAST),
        ),
        null,
        `status ${status}`,
      );
    }
    assert.equal(
      await withYahoo(
        { statusCode: 200, body: { quoteSummary: { result: [] } } },
        () => fetchQuoteSummary("DLF.NS", ["assetProfile"], FAST),
      ),
      null,
    );
  });

  it("still fires onError exactly on the swallow path, and only there", async () => {
    // `onError` (MONEY-1060) is the seam the sector worker captures the
    // swallowed error through. A 200 and the unfetchable short-circuit must
    // NOT fire it, or every ETF would be counted as an outage.
    const fired: unknown[] = [];
    await withYahoo({ statusCode: 503, body: {} }, () =>
      fetchQuoteSummary("DLF.NS", ["assetProfile"], {
        ...FAST,
        onError: (e) => fired.push(e),
      }),
    );
    assert.equal(fired.length, 1);

    await withYahoo({ statusCode: 200, body: PROFILE_BODY }, () =>
      fetchQuoteSummary("DLF.NS", ["assetProfile"], {
        ...FAST,
        onError: (e) => fired.push(e),
      }),
    );
    assert.equal(fired.length, 1, "onError fired on a successful fetch");

    // Wrapped in a mock that would 503, for two reasons (MONEY-1238). (1) The
    // unfetchable short-circuit is the ONLY thing keeping this call off the
    // wire — `withYahoo` restores the real global dispatcher on close, so an
    // un-mocked call here would reach the live Yahoo host the moment that
    // guard regressed. (2) A reply that FAILS is what makes the assertion
    // load-bearing: with a 200 the regression would be silent, while a 503
    // fires onError and turns this red.
    await withYahoo({ statusCode: 503, body: {} }, () =>
      fetchQuoteSummary("1018GS2026.NS", ["assetProfile"], {
        ...FAST,
        onError: (e) => fired.push(e),
      }),
    );
    assert.equal(fired.length, 1, "onError fired for an unfetchable symbol");
  });
});
