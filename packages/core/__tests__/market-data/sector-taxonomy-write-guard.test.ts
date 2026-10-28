/**
 * MONEY-1302 — the sector WRITE guard, and the two aliases it made safe.
 *
 * Measured on prod 2026-08-30: 101 ACTIVE instruments carried a `sector`
 * outside the 13 canonical `NSE_SECTORS`. The interesting half of that number
 * is not the aliases — it is HOW they got there and why they stayed:
 *
 *   - `normalizeToNseSector` ends in `return rawSector`, so an upstream label
 *     with no alias was written VERBATIM;
 *   - the screener's sector facet cannot reach an off-taxonomy value;
 *   - `sector-enrichment.ts` only re-selects rows whose sector is null/empty,
 *     so the row never self-heals.
 *
 * Silent on write, invisible on read, permanent thereafter. `Other` and
 * `Media & Entertainment` were NAMED as known leftovers in this taxonomy's own
 * comments for two tickets and still nobody closed them, which is exactly what
 * a defect with no failing signal looks like.
 *
 * So the durable half of this ticket is the guard, not the alias table:
 * `toWritableNseSector` rejects anything off-taxonomy, and `decideFetchOutcome`
 * turns a rejection into a FAILED fetch — nothing written, the label named in
 * the run's errors, retried next run. The alias table is data; this file pins
 * both, and pins that a write can never land in a chip nobody can click.
 *
 * Pure: no DB, no network, no timers.
 *
 * Source: packages/core/src/market-data/instruments/sector-taxonomy.ts
 *         packages/core/src/market-data/instruments/sector-enrichment-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NSE_SECTORS,
  YAHOO_TO_NSE_MAP,
  normalizeToNseSector,
  toWritableNseSector,
  resolveCanonicalSector,
  matchesSectorFacet,
} from "../../src/market-data/instruments/sector-taxonomy";
import {
  decideFetchOutcome,
  SECTOR_SKIPPED,
  type EnrichableInstrument,
} from "../../src/market-data/instruments/sector-enrichment-logic";

const INSTRUMENT: EnrichableInstrument = {
  id: "id-1",
  symbol: "ZEEL",
  exchange: "NSE",
  yahooSymbol: "ZEEL.NS",
};

describe("MONEY-1302 alias table — the labels chosen from the company names", () => {
  /**
   * Each row is the mapping decision plus the prod population it was made
   * from. The names are load-bearing: `Construction` looks like an Industrials
   * label and is 30 NHAI BONDS, which is why no mapping in this ticket was
   * made from a label alone.
   */
  const NEW_ALIASES: ReadonlyArray<{
    raw: string;
    canonical: string;
    why: string;
  }> = [
    {
      raw: "Media & Entertainment",
      canonical: "Telecommunication",
      why: "9 prod rows, all real media companies (Zee Entertainment, Zee Media, Zinema, 7Seas, Encash, P.B. Films, 3B Films). Follows the bare `Media` alias already in the table; the sector's label is 'Telecom & Media'.",
    },
    {
      raw: "Agriculture",
      canonical: "FMCG",
      why: "5 prod rows. NSE files agri-food under FMCG. JUDGEMENT CALL — Zuari Agro Chemicals is 2 of the 5 and is really a fertiliser business (Commodities).",
    },
  ];

  for (const { raw, canonical, why } of NEW_ALIASES) {
    it(`"${raw}" -> "${canonical}" — ${why}`, () => {
      assert.equal(
        YAHOO_TO_NSE_MAP[raw],
        canonical,
        `"${raw}" must map to "${canonical}" in YAHOO_TO_NSE_MAP`,
      );
      // The alias is only worth anything if it makes the rows REACHABLE — the
      // whole point is the screener chip, not the map entry.
      assert.equal(resolveCanonicalSector(raw), canonical);
      assert.equal(toWritableNseSector(raw), canonical);
      assert.equal(
        matchesSectorFacet(raw, canonical),
        true,
        `a row stored "${raw}" must be returned by the "${canonical}" chip`,
      );
      assert.equal(
        matchesSectorFacet(raw, "Not Categorised"),
        false,
        `a row stored "${raw}" must no longer fall in the catch-all`,
      );
    });
  }

  it('"Other" stays UNMAPPED — 26 of its 29 prod rows are debt, not diversified holdings', () => {
    // The tempting move was `Other -> Diversified` (the one empty bucket, and
    // 15 of the rows carry industry "Diversified"). The population refuses it:
    // 765GUJSDL29 is a Gujarat State Development Loan, EELNIFT28/NWFLNIFT26 are
    // market-linked debentures, VALIANTOCPS is preference shares. Mapping would
    // hand 26 bonds a sector chip — the state MONEY-1093 built
    // sector-write-guard.ts to prevent.
    assert.equal(YAHOO_TO_NSE_MAP.Other, undefined);
    assert.equal(resolveCanonicalSector("Other"), null);
    assert.equal(toWritableNseSector("Other"), null);
    assert.equal(matchesSectorFacet("Other", "Not Categorised"), true);
  });

  it("every alias target is a canonical sector — a typo'd target fails HERE, not in prod", () => {
    // An alias pointing at a name not in NSE_SECTORS is silently DROPPED by
    // `buildSectorFacetIndex` ("never let an alias invent a facet"), so the
    // label would keep resolving to null and keep being unreachable — with a
    // map entry that looks like it was handled.
    for (const [alias, target] of Object.entries(YAHOO_TO_NSE_MAP)) {
      assert.ok(
        target in NSE_SECTORS,
        `YAHOO_TO_NSE_MAP["${alias}"] = "${target}" is not in NSE_SECTORS`,
      );
    }
  });
});

describe("MONEY-1302 write guard — toWritableNseSector", () => {
  it("REJECTS a label the taxonomy does not know, instead of passing it through", () => {
    // The exact defect. `normalizeToNseSector` is the read-side function and
    // still returns the raw string — that is deliberate (diagnostic surfaces),
    // and it is precisely why it must not be the write-side one.
    const raw = "Consumer Staples Distribution & Retail";
    assert.equal(
      normalizeToNseSector(raw),
      raw,
      "read side still passes through",
    );
    assert.equal(toWritableNseSector(raw), null, "write side must reject");
  });

  it("accepts canonical names, aliases and any casing of either", () => {
    assert.equal(toWritableNseSector("Energy"), "Energy");
    assert.equal(
      toWritableNseSector("Consumer Cyclical"),
      "Consumer Discretionary",
    );
    assert.equal(toWritableNseSector("Basic Materials"), "Commodities");
    // Case-insensitivity is a widening: a row Yahoo returns as "energy" now
    // lands in Energy rather than off-taxonomy.
    assert.equal(toWritableNseSector("energy"), "Energy");
    assert.equal(
      toWritableNseSector("MEDIA & ENTERTAINMENT"),
      "Telecommunication",
    );
  });

  it("rejects null / undefined / empty, so a blank can never be written", () => {
    assert.equal(toWritableNseSector(null), null);
    assert.equal(toWritableNseSector(undefined), null);
    assert.equal(toWritableNseSector(""), null);
    assert.equal(toWritableNseSector("   "), null);
  });

  it("can only ever produce a value the screener facet can reach", () => {
    // The property that makes the guard worth having: WRITABLE ⊆ REACHABLE.
    // Derived from resolveCanonicalSector for exactly this reason, so the two
    // cannot drift apart into "the write landed in a chip nobody can click".
    for (const raw of [
      ...Object.keys(NSE_SECTORS),
      ...Object.keys(YAHOO_TO_NSE_MAP),
      "energy",
      "unknown label",
      "",
    ]) {
      const writable = toWritableNseSector(raw);
      if (writable === null) continue;
      assert.ok(
        writable in NSE_SECTORS,
        `"${raw}" produced non-canonical "${writable}"`,
      );
      assert.equal(
        matchesSectorFacet(writable, writable),
        true,
        `"${writable}" must be returned by its own chip`,
      );
    }
  });
});

describe("MONEY-1302 write guard — decideFetchOutcome routes the rejection", () => {
  it("an unmapped upstream sector is FAILED with no update — never written", () => {
    const outcome = decideFetchOutcome(INSTRUMENT, {
      sector: "Consumer Staples Distribution & Retail",
      industry: "Food Distributors",
    });
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.update, undefined, "nothing may be written");
    // The label has to be NAMED, or the whole point (make it loud) is lost.
    assert.match(outcome.error ?? "", /Consumer Staples Distribution & Retail/);
    assert.match(outcome.error ?? "", /YAHOO_TO_NSE_MAP/);
  });

  it("does NOT write the SKIPPED sentinel for an unmapped sector", () => {
    // The fail-open-default trap this module already fell into once
    // (MONEY-1238). "N/A" means "Yahoo has no profile and never will" — it is
    // excluded by the selector AND by forceReEnrich, so it is permanent. Yahoo
    // answering with a sector we lack an alias for is the OPPOSITE of that.
    const outcome = decideFetchOutcome(INSTRUMENT, {
      sector: "Some Brand New GICS Sector",
      industry: null,
    });
    assert.notEqual(outcome.kind, "skipped");
    assert.equal(outcome.update?.sector, undefined);
    assert.notEqual(outcome.update?.sector, SECTOR_SKIPPED);
  });

  it("still enriches a mapped sector, and stores the CANONICAL name", () => {
    // The guard must not have narrowed the happy path.
    const outcome = decideFetchOutcome(INSTRUMENT, {
      sector: "Communication Services",
      industry: "Broadcasting",
    });
    assert.equal(outcome.kind, "enriched");
    assert.equal(outcome.update?.sector, "Telecommunication");
    assert.equal(outcome.update?.industry, "Broadcasting");
  });

  it("enriches the two new aliases end-to-end through the writer's own path", () => {
    // The join, not the halves: the map entry above proves the table, this
    // proves the value a WRITE would actually persist.
    for (const [raw, expected] of [
      ["Media & Entertainment", "Telecommunication"],
      ["Agriculture", "FMCG"],
    ] as const) {
      const outcome = decideFetchOutcome(INSTRUMENT, {
        sector: raw,
        industry: null,
      });
      assert.equal(outcome.kind, "enriched", `${raw} must enrich`);
      assert.equal(outcome.update?.sector, expected);
    }
  });

  it("a genuinely absent sector is still SKIPPED, not failed", () => {
    // Yahoo answered and carries no profile — that is a real, permanent fact
    // about the symbol and is the one case the sentinel is FOR. The guard must
    // not have swallowed it into the new failure branch.
    const outcome = decideFetchOutcome(INSTRUMENT, {
      sector: null,
      industry: null,
    });
    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.update?.sector, SECTOR_SKIPPED);
  });
});
