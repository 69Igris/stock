/**
 * Tickertape MF client response mapping — REAL source (MONEY-620 de-shadow).
 *
 * Previously this file inlined `mapOverviewResponse` / `mapHoldingsResponse` /
 * `mapPeersResponse` / `resolveSidFromSearchResponse` and asserted the copies.
 * The mappers were extracted into
 * `packages/research/src/data-sources/tickertape-mf-client-logic.ts` and the
 * live fetchers (`fetchTickertapeMfOverview`, …) now import and call them; this
 * test imports the REAL symbols.
 *
 * The inline MockSidCache / MockCacheLayer / rate-limit / TTL-constant suites
 * asserted hardcoded numbers (e.g. `REQUEST_DELAY_MS === 200`, while the real
 * value is 500) and a re-implemented cache — pure reimplementation shadows with
 * no exported counterpart. They were dropped rather than kept as stale fixtures.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveSidFromSearch,
  mapMfOverview,
  mapMfHoldings,
  mapMfPeers,
} from "@usemoney/research/data-sources/tickertape-mf-client-logic";

// ── SID resolution ─────────────────────────────────────────────────────────

describe("resolveSidFromSearch", () => {
  it("returns the first mutual-fund match's sid", () => {
    const sid = resolveSidFromSearch({
      data: {
        mutualfunds: [
          { sid: "HDFC-MID-CAP-FUND", name: "HDFC Mid-Cap Opportunities" },
          { sid: "SECOND", name: "Second" },
        ],
      },
    });
    assert.strictEqual(sid, "HDFC-MID-CAP-FUND");
  });

  it("returns null when there are no matches / data is absent", () => {
    assert.strictEqual(
      resolveSidFromSearch({ data: { mutualfunds: [] } }),
      null
    );
    assert.strictEqual(resolveSidFromSearch({}), null);
    assert.strictEqual(resolveSidFromSearch({ data: {} }), null);
    assert.strictEqual(resolveSidFromSearch(null), null);
  });
});

// ── mapMfOverview ──────────────────────────────────────────────────────────

describe("mapMfOverview", () => {
  it("maps AUM / expense ratio / NAV / navDate / risk / exitLoad / minInvestment", () => {
    const r = mapMfOverview("TEST-SID", "100123", {
      data: {
        name: "Test Fund",
        aum: 25000,
        expenseRatio: 1.05,
        nav: 45.67,
        navDate: "2026-03-20",
        riskRating: "Moderately High",
        exitLoad: "1% if redeemed within 1 year",
        minInvestment: 500,
      },
    });
    assert.strictEqual(r!.aum, 25000);
    assert.strictEqual(r!.expenseRatio, 1.05);
    assert.strictEqual(r!.nav, 45.67);
    assert.strictEqual(r!.navDate, "2026-03-20");
    assert.strictEqual(r!.riskRating, "Moderately High");
    assert.strictEqual(r!.exitLoad, "1% if redeemed within 1 year");
    assert.strictEqual(r!.minInvestment, 500);
  });

  it("maps the nested returns by period key", () => {
    const r = mapMfOverview("TEST-SID", "100123", {
      data: {
        name: "F",
        returns: {
          "1m": 2.5,
          "3m": 5.1,
          "6m": 8.0,
          "1y": 15.3,
          "3y": 12.1,
          "5y": 14.5,
        },
      },
    });
    assert.strictEqual(r!.returns.oneMonth, 2.5);
    assert.strictEqual(r!.returns.threeMonth, 5.1);
    assert.strictEqual(r!.returns.sixMonth, 8.0);
    assert.strictEqual(r!.returns.oneYear, 15.3);
    assert.strictEqual(r!.returns.threeYear, 12.1);
    assert.strictEqual(r!.returns.fiveYear, 14.5);
  });

  it("leaves returns fields undefined when the returns object is missing", () => {
    const r = mapMfOverview("TEST-SID", "100123", { data: { name: "F" } });
    assert.strictEqual(r!.returns.oneMonth, undefined);
    assert.strictEqual(r!.returns.fiveYear, undefined);
  });

  it("sets the sid and falls back name → schemeCode", () => {
    assert.strictEqual(
      mapMfOverview("MY-SID", "100123", { data: { name: "X" } })!.sid,
      "MY-SID"
    );
    assert.strictEqual(
      mapMfOverview("TEST-SID", "MY-SCHEME", { data: {} })!.name,
      "MY-SCHEME"
    );
  });

  it("defaults optional fields to null and category/subCategory to ''", () => {
    const r = mapMfOverview("TEST-SID", "100", { data: { name: "Test" } });
    assert.strictEqual(r!.category, "");
    assert.strictEqual(r!.subCategory, "");
    assert.strictEqual(r!.aum, null);
    assert.strictEqual(r!.expenseRatio, null);
    assert.strictEqual(r!.nav, null);
    assert.strictEqual(r!.navDate, null);
    assert.strictEqual(r!.riskRating, null);
    assert.strictEqual(r!.exitLoad, null);
    assert.strictEqual(r!.minInvestment, null);
  });

  it("includes rawData and returns null for a null response", () => {
    assert.strictEqual(
      mapMfOverview("TEST-SID", "100", {
        data: { name: "Test", customField: 42 },
      })!.rawData.customField,
      42
    );
    assert.strictEqual(mapMfOverview("TEST-SID", "100", null), null);
  });

  it("falls back from resp.data to the top-level object", () => {
    const r = mapMfOverview("SID", "code", { name: "TopLevel", aum: 123 });
    assert.strictEqual(r!.name, "TopLevel");
    assert.strictEqual(r!.aum, 123);
  });
});

// ── mapMfHoldings ──────────────────────────────────────────────────────────

describe("mapMfHoldings", () => {
  it("maps name / ticker→symbol / sector / weight / value", () => {
    const [h] = mapMfHoldings({
      data: [
        {
          name: "Reliance Industries",
          ticker: "RELIANCE",
          sector: "Energy",
          weight: 8.5,
          value: 1200000,
        },
      ],
    })!;
    assert.strictEqual(h!.name, "Reliance Industries");
    assert.strictEqual(h!.symbol, "RELIANCE");
    assert.strictEqual(h!.sector, "Energy");
    assert.strictEqual(h!.weight, 8.5);
    assert.strictEqual(h!.value, 1200000);
  });

  it("defaults symbol/sector/value to null and weight to 0", () => {
    const [h] = mapMfHoldings({ data: [{ name: "Government Bond" }] })!;
    assert.strictEqual(h!.symbol, null);
    assert.strictEqual(h!.sector, null);
    assert.strictEqual(h!.value, null);
    assert.strictEqual(h!.weight, 0);
  });

  it("handles an empty holdings array and falls back to resp.holdings", () => {
    assert.strictEqual(mapMfHoldings({ data: [] })!.length, 0);
    const fb = mapMfHoldings({ holdings: [{ name: "Fallback", weight: 2 }] })!;
    assert.strictEqual(fb.length, 1);
    assert.strictEqual(fb[0]!.name, "Fallback");
  });

  it("returns null for a null response", () => {
    assert.strictEqual(mapMfHoldings(null), null);
  });
});

// ── mapMfPeers ─────────────────────────────────────────────────────────────

describe("mapMfPeers", () => {
  it("maps sid / name / category / returns / aum / expenseRatio", () => {
    const [p] = mapMfPeers({
      data: [
        {
          sid: "P1",
          name: "Peer Fund",
          category: "Mid Cap",
          returns1Y: 18.5,
          returns3Y: 14.2,
          aum: 5000,
          expenseRatio: 0.8,
        },
      ],
    })!;
    assert.strictEqual(p!.sid, "P1");
    assert.strictEqual(p!.name, "Peer Fund");
    assert.strictEqual(p!.category, "Mid Cap");
    assert.strictEqual(p!.returns1Y, 18.5);
    assert.strictEqual(p!.returns3Y, 14.2);
    assert.strictEqual(p!.aum, 5000);
    assert.strictEqual(p!.expenseRatio, 0.8);
  });

  it("defaults missing peer fields to null", () => {
    const [p] = mapMfPeers({
      data: [{ sid: "P1", name: "Peer", category: "X" }],
    })!;
    assert.strictEqual(p!.returns1Y, null);
    assert.strictEqual(p!.returns3Y, null);
    assert.strictEqual(p!.aum, null);
    assert.strictEqual(p!.expenseRatio, null);
  });

  it("handles an empty peers array and falls back to resp.peers", () => {
    assert.strictEqual(mapMfPeers({ data: [] })!.length, 0);
    const fb = mapMfPeers({
      peers: [{ sid: "FB", name: "FB Peer", category: "L" }],
    })!;
    assert.strictEqual(fb.length, 1);
    assert.strictEqual(fb[0]!.name, "FB Peer");
  });

  it("returns null for a null response", () => {
    assert.strictEqual(mapMfPeers(null), null);
  });
});
