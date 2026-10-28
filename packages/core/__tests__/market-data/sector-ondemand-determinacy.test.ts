/**
 * MONEY-1238 (#7, second path) — the ON-DEMAND sector fetcher had the same
 * fail-open default as the weekly worker, and it is the more damaging of the two.
 *
 * `defaultYahooSectorFetcher` called the lossy `fetchQuoteSummary`, whose `null`
 * means BOTH "Yahoo refused us" and "this symbol genuinely has no
 * assetProfile". Its caller cannot tell them apart, so it wrote the SKIPPED
 * sentinel for both — and that write is effectively permanent: the enrichment
 * selector only picks rows with NO sector, and even `forceReEnrich` excludes the
 * sentinel. One bad minute of Yahoo marks those instruments "N/A" for good.
 *
 * ## Why this path matters more than the weekly job
 *
 * The worker touches at most 500 rows on a Sunday schedule. THIS one is fired
 * on every holdings read (fire-and-forget, up to 25 symbols per call), so it
 * poisons rows continuously — and under exactly the request load that provokes
 * Yahoo into rate-limiting us in the first place. Fixing only the worker, as
 * the first pass did, left the faster leak running.
 *
 * The repo rule being enforced: NEVER CACHE A FAIL-OPEN DEFAULT. "Couldn't
 * determine" must be its own value, and the decision must key on determinacy
 * rather than on the value.
 *
 * Source: packages/core/src/market-data/instruments/sector-enrichment.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultYahooSectorFetcher } from "../../src/market-data/instruments/sector-enrichment";
import { isSectorFetchUnavailable } from "../../src/market-data/instruments/sector-enrichment-logic";
import { installMockAgent, stubYahooAuth } from "../_contracts/mock-agent";

const YAHOO = "https://query2.finance.yahoo.com";
const SUMMARY_PATH = /^\/v10\/finance\/quoteSummary\//;

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

const profileBody = (
  sector: string | null,
  industry: string | null,
): unknown => ({
  quoteSummary: {
    result: [
      {
        assetProfile: {
          ...(sector ? { sector } : {}),
          ...(industry ? { industry } : {}),
        },
      },
    ],
    error: null,
  },
});

describe("MONEY-1238 — the on-demand sector fetcher separates outage from absence", () => {
  it("an OUTAGE throws a tagged error, so nothing is written", async () => {
    // THE DEFECT. A 503 used to arrive as `null`, indistinguishable from an ETF
    // with no profile, and the caller wrote a permanent "N/A". Both call sites
    // in this module already wrap the fetch in try/catch -> decideErrorOutcome,
    // which checks the tag FIRST and returns `failed` with NO update — so a
    // throw costs a retry on the next holdings read instead of a poisoned row.
    await withYahoo(
      { statusCode: 503, body: { error: "unavailable" } },
      async () => {
        await assert.rejects(
          () => defaultYahooSectorFetcher("RELIANCE.NS"),
          (err: unknown) => {
            assert.ok(
              isSectorFetchUnavailable(err),
              `an outage must be TAGGED unavailable, got: ${String(err)}`,
            );
            return true;
          },
        );
      },
    );
  });

  it("an EMPTY result set returns null — Yahoo answered, it just knows nothing", async () => {
    // Distinct from the case below, and it was NOT covered until a mutation
    // proved it: `result: [{}]` yields kind "ok" with no assetProfile, which
    // exits through `if (!profile)`. The `kind === "empty"` branch needs an
    // actually-empty `result` array. Without this case, over-correcting the fix
    // to throw on EMPTY as well as on UNAVAILABLE went undetected — and that
    // would turn every profile-less ETF into a permanent retry.
    await withYahoo(
      { statusCode: 200, body: { quoteSummary: { result: [], error: null } } },
      async () => {
        assert.equal(await defaultYahooSectorFetcher("NIFTYBEES.NS"), null);
      },
    );
  });

  it("a genuine ABSENCE still returns null, which the caller MAY write down", async () => {
    // The control, and the reason this cannot simply throw on every null: an
    // ETF or index legitimately has no assetProfile. Yahoo ANSWERED, so the
    // answer is determinate and recording it is correct.
    await withYahoo(
      {
        statusCode: 200,
        body: { quoteSummary: { result: [{}], error: null } },
      },
      async () => {
        assert.equal(await defaultYahooSectorFetcher("NIFTYBEES.NS"), null);
      },
    );
  });

  it("a real profile comes back intact", async () => {
    // Without this, a fetcher that threw on everything would satisfy the first
    // case and still be completely broken.
    await withYahoo(
      { statusCode: 200, body: profileBody("Energy", "Oil & Gas Refining") },
      async () => {
        assert.deepEqual(await defaultYahooSectorFetcher("RELIANCE.NS"), {
          sector: "Energy",
          industry: "Oil & Gas Refining",
        });
      },
    );
  });

  it("a 200 with a profile but no sector is an ANSWER, not an outage", async () => {
    // The boundary between the two cases above: Yahoo replied and the profile
    // exists but carries no sector. Determinate — null, not a throw.
    await withYahoo(
      { statusCode: 200, body: profileBody(null, "Some Industry") },
      async () => {
        assert.deepEqual(await defaultYahooSectorFetcher("X.NS"), {
          sector: null,
          industry: "Some Industry",
        });
      },
    );
  });
});
