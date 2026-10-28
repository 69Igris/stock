/**
 * MFAPI.in MF overview client — REAL exports (pure mapping + returns).  MONEY-1073
 *
 * Tickertape's MF API stopped returning open-ended funds, so MF research came
 * back "Data Unavailable". These bind the REAL exports and pin the MFAPI.in
 * fallback: date parsing, trailing-return math (point-to-point ≤1Y, CAGR >1Y,
 * omit periods beyond history), non-finite guards, and the MfOverview mapping.
 *
 * Returns are computed relative to the LATEST NAV date in the payload (not the
 * wall clock), so the fixture is deterministic — no Date.now() dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseMfApiDate,
  computeMfReturns,
  buildMfOverviewFromMfApi,
  type MfApiResponse,
} from "../src/data-sources/mfapi-mf-client";

// Newest-first daily NAV points ~3Y of history (latest 2026-07-18).
const FIXTURE: MfApiResponse = {
  meta: {
    fund_house: "Bandhan Mutual Fund",
    scheme_type: "Open Ended Schemes(Debt Scheme)",
    scheme_category: "Debt Scheme - Banking and PSU Fund",
    scheme_code: 121279,
    scheme_name: "Bandhan Banking and PSU Fund - Direct Growth",
  },
  data: [
    { date: "18-07-2026", nav: "12.0000" }, // latest
    { date: "18-06-2026", nav: "11.8800" }, // ~1M
    { date: "18-04-2026", nav: "11.6000" }, // ~3M
    { date: "18-01-2026", nav: "11.2000" }, // ~6M
    { date: "18-07-2025", nav: "11.0000" }, // ~1Y
    { date: "18-07-2024", nav: "10.0000" }, // ~2Y
    { date: "18-07-2023", nav: "9.0000" }, //  ~3Y (oldest)
  ],
  status: "SUCCESS",
};

describe("MONEY-1073 — parseMfApiDate", () => {
  it("parses DD-MM-YYYY to a finite epoch", () => {
    assert.equal(parseMfApiDate("18-07-2026"), Date.UTC(2026, 6, 18));
  });
  it("rejects garbage / wrong format → null", () => {
    assert.equal(parseMfApiDate("2026-07-18"), null);
    assert.equal(parseMfApiDate("garbage"), null);
    assert.equal(parseMfApiDate(""), null);
  });
});

describe("MONEY-1073 — computeMfReturns", () => {
  const r = computeMfReturns(FIXTURE.data);

  it("point-to-point returns for ≤1Y periods", () => {
    assert.ok(Math.abs(r.oneMonth! - 1.01) < 0.3, `1M ${r.oneMonth}`);
    assert.ok(Math.abs(r.oneYear! - 9.09) < 0.5, `1Y ${r.oneYear}`);
  });

  it("annualized CAGR for the 3Y period (not raw 33%)", () => {
    // (12/9)^(1/3)-1 ≈ 10.06%, NOT the point-to-point 33.3%.
    assert.ok(Math.abs(r.threeYear! - 10.06) < 0.7, `3Y ${r.threeYear}`);
    assert.ok(r.threeYear! < 15, "must be annualized, not point-to-point");
  });

  it("omits periods with insufficient history (no 5Y from 3Y of data)", () => {
    assert.equal(r.fiveYear, undefined);
  });

  it("all emitted returns are finite (no NaN poison)", () => {
    for (const v of Object.values(r)) assert.ok(Number.isFinite(v));
  });

  it("garbage / zero NAVs are dropped, never producing NaN", () => {
    const bad = computeMfReturns([
      { date: "18-07-2026", nav: "abc" },
      { date: "18-06-2026", nav: "0" },
      { date: "18-05-2026", nav: "-5" },
    ]);
    assert.deepEqual(bad, {});
    assert.deepEqual(computeMfReturns([]), {});
    assert.deepEqual(computeMfReturns(undefined), {});
  });
});

describe("MONEY-1073 — buildMfOverviewFromMfApi", () => {
  it("maps name / category / latest NAV from the MFAPI payload", () => {
    const o = buildMfOverviewFromMfApi("121279", FIXTURE);
    assert.ok(o);
    assert.equal(o.name, "Bandhan Banking and PSU Fund - Direct Growth");
    assert.equal(o.category, "Debt Scheme - Banking and PSU Fund");
    assert.equal(o.nav, 12);
    assert.equal(o.navDate, "2026-07-18");
    assert.equal(o.sid, "121279");
    assert.ok(o.returns.oneYear && o.returns.oneYear > 0);
    // MFAPI carries no AUM / expense ratio → explicit null (not fabricated).
    assert.equal(o.aum, null);
    assert.equal(o.expenseRatio, null);
  });

  it("returns null when there is no meta or no NAV history", () => {
    assert.equal(buildMfOverviewFromMfApi("1", null), null);
    assert.equal(
      buildMfOverviewFromMfApi("1", { meta: FIXTURE.meta, data: [] }),
      null,
    );
    assert.equal(buildMfOverviewFromMfApi("1", { data: FIXTURE.data }), null);
  });
});
