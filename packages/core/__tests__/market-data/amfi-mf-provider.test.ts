/**
 * `parseAmfiFeed` line grammar + feed URL — MONEY-1198.
 *
 * This module is the SHIPPED MutualFundMaster ingest, and it had been writing
 * wrong data to prod for as long as it has existed. Both defects here are of the
 * kind that produce a plausible row rather than an error, which is why neither
 * was noticed by anything downstream.
 *
 * Run against the same TRIMMED BUT VERBATIM capture of the live NAVAll feed that
 * `amfi-scheme-bridge.test.ts` uses (`__tests__/fixtures/amfi-navall/
 * NAVAll.trimmed.txt`, AMFI's bytes from 2026-08-14, whole lines dropped and
 * nothing else). A synthetic fixture would have been written by whoever wrote
 * the parser and would therefore have agreed with it by construction — and the
 * entire bug is that the parser's model of the file was wrong, not that its code
 * disagreed with its model.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseAmfiFeed,
  fetchAmfiNavFeed,
  resolveIsinToSchemeCode,
} from "../../src/market-data/instruments/amfi-mf-provider";
import { AMFI_NAVALL_URL } from "../../src/market-data/amfi-scheme-bridge";

const NAVALL_FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "amfi-navall",
  "NAVAll.trimmed.txt",
);

const TEXT = readFileSync(NAVALL_FIXTURE, "utf8");
const FUNDS = parseAmfiFeed(TEXT);

describe("parseAmfiFeed reads the feed's TWO header kinds (MONEY-1198)", () => {
  it("parses a plausible number of funds — a silent zero would pass everything below", () => {
    // Every assertion in this file is vacuously true on an empty parse, and an
    // empty parse is a real failure mode here: a shape change that yields []
    // reads as "no schemes published today", not as a broken parser.
    assert.ok(FUNDS.length > 500, `parsed only ${FUNDS.length} funds`);
  });

  it("REGRESSION: no fund is filed under a SECTION header as its AMC", () => {
    // THE BUG. `if (!trimmed.includes(";")) currentAmc = trimmed` treated every
    // semicolon-free line as an AMC name, but NAVAll interleaves 90 SECTION
    // headers ("Open Ended Schemes(Growth)") with 52 AMC headers and both are
    // semicolon-free. It self-corrected wherever an AMC header followed a
    // section header — nearly everywhere, which is exactly why it survived —
    // so the damage was confined to the three sections that carry no AMC header
    // of their own. On the live feed that was 16 rows in MutualFundMaster whose
    // amcName was a section name.
    const misfiled = [
      ...new Set(
        FUNDS.filter((f) => /Schemes?\(/.test(f.amcName)).map((f) => f.amcName),
      ),
    ];
    assert.deepEqual(
      misfiled,
      [],
      "a section header was stored as an AMC name — see SECTION_HEADER in " +
        "amfi-mf-provider.ts and the grammar in amfi-scheme-bridge.ts",
    );
  });

  it("REGRESSION: carries the previous AMC across a section with no AMC header", () => {
    // The other half of the fix, and the half a naive repair gets wrong.
    // CLEARING the AMC at a section boundary would also satisfy the assertion
    // above while silently dropping these rows (or filing them under a
    // sentinel). Three live sections have no AMC header of their own; their
    // rows belong to the AMC of the preceding section.
    //
    // Scheme 103028 sits inside `Open Ended Schemes(Growth)` and is ICICI
    // Prudential's; 154437 sits inside the Life Cycle Fund section and is
    // Zerodha's. Both are asserted by scheme code, not by position, so a
    // re-trim of the fixture cannot quietly make this pass by removing them.
    const byCode = new Map(FUNDS.map((f) => [f.schemeCode, f]));

    const icici = byCode.get("103028");
    assert.ok(icici, "fixture must retain scheme 103028 (headerless section)");
    assert.equal(icici.amcName, "ICICI Prudential Mutual Fund");

    const zerodha = byCode.get("154437");
    assert.ok(
      zerodha,
      "fixture must retain scheme 154437 (headerless section)",
    );
    assert.equal(zerodha.amcName, "Zerodha Mutual Fund");
  });

  it("keeps an AMC whose own name parenthesises like a section", () => {
    // `IL&FS Mutual Fund (IDF)` is why the discriminator is `Schemes?\(` and
    // not a `/Mutual Fund$/` suffix test: it neither ends in "Mutual Fund" nor
    // lacks parentheses. A suffix rule would file its schemes under whatever
    // section preceded it. Skipped rather than failed if the trim dropped it —
    // asserting on a row the fixture need not contain would make this suite
    // brittle for a reason unrelated to what it tests.
    const amcNames = new Set(FUNDS.map((f) => f.amcName));
    const ilfs = [...amcNames].filter((n) => n.startsWith("IL&FS"));
    if (ilfs.length > 0) {
      assert.deepEqual(ilfs, ["IL&FS Mutual Fund (IDF)"]);
    }
  });

  it("never leaves a fund on the pre-header sentinel", () => {
    // "Unknown AMC" is the initial value. A row carrying it means a data line
    // appeared before any AMC header — which would be a grammar change worth
    // failing on, not a row to store.
    const unknown = FUNDS.filter((f) => f.amcName === "Unknown AMC");
    assert.equal(unknown.length, 0, `${unknown.length} funds have no AMC`);
  });

  it("resolves a sane number of distinct AMCs", () => {
    // Guards the guard from the opposite direction. If the discriminator ever
    // matched EVERYTHING, `currentAmc` would never advance and every fund would
    // collapse onto one AMC — which the assertions above would not catch.
    const amcs = new Set(FUNDS.map((f) => f.amcName));
    assert.ok(
      amcs.size >= 5,
      `only ${amcs.size} distinct AMCs — the section discriminator is probably matching AMC headers too`,
    );
  });
});

describe("AMFI feed URL points at the canonical host (MONEY-1198)", () => {
  it("uses portal.amfiindia.com, not the redirecting www host", () => {
    // `www.amfiindia.com/spages/NAVAll.txt` answers 302 -> portal (verified
    // 2026-08-14). `fetch` follows redirects by default, so the www form still
    // WORKED — which is the point: the whole MF NAV ingest was resting on a
    // redirect, and `redirect: "manual"`, a non-following fetch wrapper, or a
    // host-scoped egress rule would each have broken it with no code change to
    // blame. Pinning the canonical host makes the redirect non-load-bearing.
    assert.equal(
      AMFI_NAVALL_URL,
      "https://portal.amfiindia.com/spages/NAVAll.txt",
    );
  });

  it("the provider and the bridge agree on the host", () => {
    // The two constants are deliberately duplicated (the provider is the
    // low-level ingest, the bridge a higher-level consumer; importing upward
    // would invert that dependency for one string). Duplication is only safe
    // while something notices them diverging.
    const providerSrc = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "market-data",
        "instruments",
        "amfi-mf-provider.ts",
      ),
      "utf8",
    );
    const hit = /const AMFI_NAV_URL = "([^"]+)"/.exec(providerSrc);
    assert.ok(hit, "AMFI_NAV_URL not found — did the constant get renamed?");
    assert.equal(hit[1], AMFI_NAVALL_URL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-1404 C6 — the feed rides the archive seam, and a MISS is a FAILURE
// ─────────────────────────────────────────────────────────────────────────────
//
// `no-feed-fetch-bypass.test.ts` pins the SHAPE of the call (seamed, dated,
// per-day basename). These two drive the real function instead, because the
// property that matters is behavioural and the scan cannot see it: what this
// module does with the `null` that `getFeedAsset` returns on a 404.
//
// The seam maps 404 -> null meaning "not published yet — weekend, holiday,
// pre-EOD", which is right for a bhavcopy and WRONG for a file AMFI publishes
// every calendar day. Reading that null as an empty feed is MONEY-1403 exactly:
// for 26 nights "nothing came back" and "nothing was published" were one value.

describe("NAVAll through the archive seam (MONEY-1404 C6)", () => {
  /** Run `fn` with `globalThis.fetch` replaced, always restoring it. */
  async function withFetch<T>(
    impl: () => Promise<unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  }

  it("a 404 THROWS — it is never read as a day with no schemes", async () => {
    // MUTATION: `if (res === null) throw ...` -> `return ""` in
    // fetchNavAllText. Went RED here (this rejects nothing and the parse
    // returns []) AND in no-feed-fetch-bypass.test.ts's shape scan.
    await withFetch(
      async () => ({ ok: false, status: 404, statusText: "Not Found" }),
      async () => {
        await assert.rejects(
          () => fetchAmfiNavFeed(),
          /Failed to fetch AMFI NAV feed: 404/,
          "a 404 from AMFI must reject; getFeedAsset returns null for it and " +
            "null here means a broken fetch, not an empty publication day",
        );
      },
    );
  });

  it("the ISIN resolver degrades to null on that same 404, not a throw", async () => {
    // The other caller of the same fetcher, and it must keep its OWN contract:
    // it is a fallback inside a lookup, so an unreachable feed means "could not
    // resolve", not an exception into a request path.
    //
    // MUTATION: made resolveIsinToSchemeCode's catch `throw error` instead of
    // returning null -> RED (this rejects instead of resolving to null).
    await withFetch(
      async () => ({ ok: false, status: 404, statusText: "Not Found" }),
      async () => {
        assert.equal(await resolveIsinToSchemeCode("INF179K01AA1"), null);
      },
    );
  });

  it("a 200 still parses — the seam is passthrough when nothing is registered", async () => {
    // The other half. A guard that only proves the failure path would pass just
    // as happily if the fetcher had stopped working altogether.
    //
    // MUTATION: `return res.text()` -> `return ""` in fetchNavAllText -> RED
    // (the parse throws AmfiNavGrammarError on empty bytes).
    const funds = await withFetch(
      async () => ({ ok: true, status: 200, text: async () => TEXT }),
      () => fetchAmfiNavFeed(),
    );
    assert.equal(funds.length, FUNDS.length);
    assert.ok(funds.length > 500, `parsed only ${funds.length} funds`);
  });
});
