/**
 * MONEY-1238 (#7) — an OUTAGE must never be written down as a FACT.
 *
 * `SECTOR_SKIPPED` ("N/A") is effectively permanent: the enrichment selector
 * only picks rows whose sector is null/empty, and even `forceReEnrich` excludes
 * the sentinel. Writing it says "Yahoo has no profile for this symbol and never
 * will".
 *
 * The fetchers could not make that claim honestly. `fetchQuoteSummary` catches
 * EVERY error and returns `null`, so "Yahoo 500ed / timed out / blocked our
 * egress" and "this ETF genuinely has no assetProfile" were the SAME VALUE —
 * and the null branch wrote the permanent sentinel while reporting `failed=0`,
 * because the failure branch was unreachable for any network fault. A 500-row
 * outage logged `processed=500, enriched=0, failed=0, skipped=500`, which is
 * byte-identical to 500 genuine ETFs.
 *
 * These tests pin the DECISIONS that separate the two, and a structural read
 * pins the orchestrator loop that consumes them — because "failed" is only
 * worth anything if the orchestrator writes nothing for it.
 *
 * Sources under test:
 *   packages/core/src/market-data/instruments/sector-enrichment-logic.ts
 *   packages/core/src/market-data/yahoo-api.ts
 *   packages/core/src/market-data/instruments/sector-enrichment.ts (structural)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SECTOR_SKIPPED,
  SECTOR_FETCH_UNAVAILABLE,
  SectorFetchUnavailableError,
  isSectorFetchUnavailable,
  isPermanentSymbolError,
  toSectorFetchError,
  decideFetchOutcome,
  decideErrorOutcome,
  type EnrichableInstrument,
  type EnrichmentOutcome,
} from "../../src/market-data/instruments/sector-enrichment-logic";
import { yahooErrorStatus } from "../../src/market-data/yahoo-api";

const INST: EnrichableInstrument = {
  id: "inst-1",
  symbol: "DLF",
  exchange: "NSE",
  yahooSymbol: "DLF.NS",
};

/** LINE comments first, then BLOCK comments (repo guard, MONEY-1143). */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// yahooErrorStatus — recovering the HTTP status from a yahooFetch rejection
// ═══════════════════════════════════════════════════════════════════════════

describe("yahooErrorStatus", () => {
  it("recovers the status from yahooFetch's HTTP rejection", () => {
    assert.equal(
      yahooErrorStatus(new Error("Yahoo Finance API error: 404 Not Found")),
      404,
    );
    assert.equal(
      yahooErrorStatus(
        new Error("Yahoo Finance API error: 503 Service Unavailable"),
      ),
      503,
    );
    assert.equal(
      yahooErrorStatus(new Error("Yahoo Finance API error: 403 Forbidden")),
      403,
    );
  });

  it("is null for the transport shapes, which carry no status at all", () => {
    assert.equal(
      yahooErrorStatus(
        new Error("Yahoo Finance API request timed out after 15000ms"),
      ),
      null,
    );
    assert.equal(
      yahooErrorStatus(
        new Error("Yahoo Finance API network error: fetch failed"),
      ),
      null,
    );
    assert.equal(
      yahooErrorStatus(new Error("Yahoo Finance API: max retries exceeded")),
      null,
    );
  });

  it("is ANCHORED — a bare 404 in the text is not a status", () => {
    // The rule this replaces was `msg.includes("404")`, which also matches a
    // latency ("404ms"), a symbol, a URL path, or a response body.
    assert.equal(
      yahooErrorStatus(new Error("Yahoo Finance API error: 500 (took 404ms)")),
      500,
    );
    assert.equal(yahooErrorStatus(new Error("timed out after 404ms")), null);
    assert.equal(yahooErrorStatus(null), null);
    // It reads any throwable's text, not just an Error's — `yahooFetch` only
    // ever throws Errors, but a thrown string carrying the real prefix is a
    // real status and there is no reason to lose it.
    assert.equal(yahooErrorStatus("Yahoo Finance API error: 404"), 404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The three-state fetch result
// ═══════════════════════════════════════════════════════════════════════════

describe("decideFetchOutcome is three-state, and only ONE state writes", () => {
  it("UNAVAILABLE is FAILED and carries NO update — nothing is written", () => {
    const o = decideFetchOutcome(INST, SECTOR_FETCH_UNAVAILABLE);
    assert.equal(o.kind, "failed");
    assert.equal(o.update, undefined);
    assert.ok(o.error && o.error.includes("DLF"));
  });

  it("a well-formed answer with no profile is SKIPPED and DOES write N/A", () => {
    // Unchanged behaviour, and it is the case the sentinel exists for.
    const o = decideFetchOutcome(INST, null);
    assert.equal(o.kind, "skipped");
    assert.equal(o.update?.sector, SECTOR_SKIPPED);
    assert.equal(o.update?.industry, SECTOR_SKIPPED);
  });

  it("a profile with a null sector is still SKIPPED, not UNAVAILABLE", () => {
    const o = decideFetchOutcome(INST, { sector: null, industry: "Realty" });
    assert.equal(o.kind, "skipped");
    assert.equal(o.update?.sector, SECTOR_SKIPPED);
  });

  it("a real sector is ENRICHED and normalised", () => {
    // "Realty" is NSE/screener's spelling; the canonical bucket is
    // "Real Estate" (MONEY-1093). Feeding the non-canonical spelling proves
    // the normaliser actually ran.
    const o = decideFetchOutcome(INST, {
      sector: "Realty",
      industry: "Real Estate Development",
    });
    assert.equal(o.kind, "enriched");
    assert.equal(o.update?.sector, "Real Estate");
    assert.equal(o.update?.industry, "Real Estate Development");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The tag beats the text — the guard the whole fix rests on
// ═══════════════════════════════════════════════════════════════════════════

describe("decideErrorOutcome never skips a TAGGED transport failure", () => {
  it("a tagged error whose message contains 404 is still FAILED", () => {
    // The old rule was a bare `includes("404")` over `symbol: message`. A
    // transport error is free to mention 404 — a redirect chain, a proxy body,
    // a URL, a latency — and the moment it does, the old rule writes a
    // PERMANENT sentinel for a symbol nobody ever asked about.
    const tagged = new SectorFetchUnavailableError(
      "DLF",
      new Error("proxy returned 404 page while upstream was 503"),
    );
    const o = decideErrorOutcome(INST, tagged);
    assert.equal(o.kind, "failed");
    assert.equal(o.update, undefined);
  });

  it("a genuine Yahoo 404 is SKIPPED — deterministic, and permanent", () => {
    const o = decideErrorOutcome(
      INST,
      new Error("Yahoo Finance API error: 404 Not Found"),
    );
    assert.equal(o.kind, "skipped");
    assert.equal(o.update?.sector, SECTOR_SKIPPED);
  });

  it("a 503 / timeout / network fault is FAILED and writes NOTHING", () => {
    for (const msg of [
      "Yahoo Finance API error: 503 Service Unavailable",
      "Yahoo Finance API error: 403 Forbidden",
      "Yahoo Finance API error: 429 Too Many Requests",
      "Yahoo Finance API request timed out after 15000ms",
      "Yahoo Finance API network error: fetch failed",
    ]) {
      const o = decideErrorOutcome(INST, new Error(msg));
      assert.equal(o.kind, "failed", msg);
      assert.equal(o.update, undefined, msg);
    }
  });

  it("a NON-Error throw is FAILED, even when it says 404", () => {
    // Conservative on purpose: the rule this replaced read
    // `error instanceof Error ? error.message : "Unknown error"`, so a bare
    // string fell through to FAILED. Widening it would have converted that
    // case into a permanent WRITE — the one direction this fix must not drift.
    assert.equal(isPermanentSymbolError("404 not found"), false);
    const o = decideErrorOutcome(INST, "404 not found");
    assert.equal(o.kind, "failed");
    assert.equal(o.update, undefined);
  });
});

describe("isSectorFetchUnavailable survives a duplicated module copy", () => {
  it("matches the class", () => {
    assert.equal(
      isSectorFetchUnavailable(
        new SectorFetchUnavailableError("DLF", new Error("boom")),
      ),
      true,
    );
  });

  it("matches a structural twin from a SECOND copy of the module", () => {
    // The error crosses workers -> @usemoney/core. Under a bundler that
    // duplicates the module, `instanceof` against the other copy returns false
    // and the check would fall through to the 404 text rule — i.e. straight
    // back to writing a permanent sentinel during an outage.
    assert.equal(
      isSectorFetchUnavailable({ isSectorFetchUnavailable: true }),
      true,
    );
  });

  it("does not match an ordinary error, or a non-object", () => {
    assert.equal(isSectorFetchUnavailable(new Error("503")), false);
    assert.equal(isSectorFetchUnavailable(null), false);
    assert.equal(isSectorFetchUnavailable("unavailable"), false);
  });
});

describe("toSectorFetchError decides what stays raw", () => {
  it("a 404 stays RAW so the existing skip rule still applies", () => {
    const raw = new Error("Yahoo Finance API error: 404 Not Found");
    assert.equal(toSectorFetchError("DLF", raw), raw);
    assert.equal(
      decideErrorOutcome(INST, toSectorFetchError("DLF", raw)).kind,
      "skipped",
    );
  });

  it("everything else is TAGGED", () => {
    const wrapped = toSectorFetchError(
      "DLF",
      new Error("Yahoo Finance API error: 503 Service Unavailable"),
    );
    assert.equal(isSectorFetchUnavailable(wrapped), true);
    assert.equal(decideErrorOutcome(INST, wrapped).kind, "failed");
  });

  it("an already-tagged error is passed through, not double-wrapped", () => {
    const tagged = new SectorFetchUnavailableError("DLF", new Error("boom"));
    assert.equal(toSectorFetchError("DLF", tagged), tagged);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The orchestrator must not write for a FAILED outcome (structural)
// ═══════════════════════════════════════════════════════════════════════════

describe("enrichSectors consumes the outcome without writing on FAILED", () => {
  const SRC = stripComments(
    readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "market-data",
        "instruments",
        "sector-enrichment.ts",
      ),
      "utf8",
    ),
  );

  it("EVERY fetch site is inside a try whose catch routes to decideErrorOutcome", () => {
    // A fetcher that THROWS is how the worker reports an outage without
    // widening `YahooSectorFetcher`. If the catch stopped calling
    // decideErrorOutcome, every outage would abort the batch instead.
    //
    // A single `assert.match` was NOT enough, and that is mutation-verified
    // (MONEY-1238): this file holds TWO enrichment loops — the cron batch
    // `enrichSectors` and the on-demand `enrichInstrumentsBySymbol` — so
    // stripping the routing out of EITHER one left the other satisfying the
    // regex and the test green. Count instead: every `await fetcher(...)` site
    // must be paired with a catch that routes.
    const fetchSites = (
      SRC.match(/await fetcher\(instrument\.yahooSymbol\)/g) ?? []
    ).length;
    assert.ok(fetchSites >= 2, "expected both enrichment loops");
    const paired = [
      ...SRC.matchAll(
        // Bounded on BOTH gaps. The first (0-40) only has to clear the
        // `const sectorData =` line; the second (0-260) covers the enriched
        // console.log block and stops well short of the next loop, so a match
        // can never span two try/catch blocks.
        /try \{\n\s*const sectorData = await fetcher\(instrument\.yahooSymbol\);\n\s{0,40}outcome = decideFetchOutcome\(instrument, sectorData\);[\s\S]{0,260}?\n\s*\} catch \(error\) \{\n\s*outcome = decideErrorOutcome\(instrument, error\);\n/g,
      ),
    ];
    assert.equal(
      paired.length,
      fetchSites,
      "a fetch site whose catch does not route to decideErrorOutcome",
    );
  });

  it("only enriched/skipped push an update; the failed branch pushes none", () => {
    // This is what makes "failed" mean UNWRITTEN. `outcome.update` is optional
    // and a FAILED outcome never carries one, but the loop must also not have
    // its own unconditional push.
    const pushes = SRC.match(/pendingUpdates\.push\(/g) ?? [];
    assert.ok(pushes.length >= 2, "expected the enriched/skipped pushes");
    for (const m of SRC.matchAll(/pendingUpdates\.push\(([^)]*)\)/g)) {
      assert.match(
        m[1]!,
        /outcome\.update/,
        "a push that is not guarded by outcome.update",
      );
    }
    // Every push site sits behind an `if (outcome.update)`.
    assert.equal(
      (SRC.match(/if \(outcome\.update\) pendingUpdates\.push\(/g) ?? [])
        .length,
      pushes.length,
    );
  });

  it("the failed branch increments `failed` and records the error", () => {
    assert.match(SRC, /result\.failed\+\+/);
    assert.match(SRC, /result\.errors\.push\(outcome\.error\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The counters TELL THE TWO APART — the point of the whole ticket
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The per-instrument body of `enrichSectors`' loop, over the REAL decision
 * functions. Kept to the four lines the structural block above pins, so it
 * cannot drift into a shadow of a loop that no longer exists.
 */
async function runBatch(
  instruments: EnrichableInstrument[],
  fetcher: (yahooSymbol: string) => Promise<{
    sector: string | null;
    industry: string | null;
  } | null>,
) {
  const counters = { enriched: 0, skipped: 0, failed: 0 };
  const writes: Array<{ id: string; sector: string }> = [];
  for (const instrument of instruments) {
    let outcome: EnrichmentOutcome;
    try {
      outcome = decideFetchOutcome(
        instrument,
        await fetcher(instrument.yahooSymbol),
      );
    } catch (error) {
      outcome = decideErrorOutcome(instrument, error);
    }
    if (outcome.kind === "enriched") {
      if (outcome.update) writes.push(outcome.update);
      counters.enriched++;
    } else if (outcome.kind === "skipped") {
      if (outcome.update) writes.push(outcome.update);
      counters.skipped++;
    } else {
      counters.failed++;
    }
  }
  return { counters, writes };
}

describe("an outage and a profileless batch are DISTINGUISHABLE", () => {
  const batch: EnrichableInstrument[] = Array.from({ length: 5 }, (_, i) => ({
    id: `id-${i}`,
    symbol: `SYM${i}`,
    exchange: "NSE",
    yahooSymbol: `SYM${i}.NS`,
  }));

  it("OUTAGE: failed=5, skipped=0, and ZERO writes", async () => {
    const { counters, writes } = await runBatch(batch, async (s) => {
      throw new SectorFetchUnavailableError(
        s,
        new Error("Yahoo Finance API error: 503 Service Unavailable"),
      );
    });
    assert.deepEqual(counters, { enriched: 0, skipped: 0, failed: 5 });
    assert.equal(writes.length, 0, "an outage wrote to the database");
  });

  it("PROFILELESS: skipped=5, failed=0, and 5 N/A writes", async () => {
    const { counters, writes } = await runBatch(batch, async () => null);
    assert.deepEqual(counters, { enriched: 0, skipped: 5, failed: 0 });
    assert.equal(writes.length, 5);
    assert.ok(writes.every((w) => w.sector === SECTOR_SKIPPED));
  });

  it("the two batches do NOT produce the same counters", async () => {
    // Before the fix they did, exactly: `failed=0, skipped=N` for both. That
    // identity is the bug — this assertion is the ticket.
    //
    // It therefore has to compare two RUNS. This was written as
    // `assert.notDeepEqual({...literal}, {...literal})`, which asserts a
    // property of two object literals typed into the test file and CANNOT be
    // turned red by any change to the source — mutation-verified vacuous
    // (MONEY-1238). Every counter below now comes out of `runBatch`.
    const outage = await runBatch(batch, async (s) => {
      throw new SectorFetchUnavailableError(
        s,
        new Error("Yahoo Finance API error: 503 Service Unavailable"),
      );
    });
    const profileless = await runBatch(batch, async () => null);
    assert.notDeepEqual(outage.counters, profileless.counters);
    assert.equal(outage.counters.failed, batch.length);
    assert.equal(profileless.counters.failed, 0);
    assert.notEqual(outage.writes.length, profileless.writes.length);
  });
});
