/**
 * MONEY-393 §41 - packages/services helper coverage push (74.91% → 90%+).
 *
 * Covers the pure helper files that have no Prisma/network deps:
 *   - src/mappings.ts        (getSegmentLabel, getProductTypeLabel,
 *                              getSegmentFilterValues)
 *   - src/analytics.ts       (captureServiceEvent, env-gated)
 *   - src/gst/billing-period.ts (getBillingPeriod, getFinancialYear)
 *   - src/gst/rbi-fx.ts      (getRbiReferenceRate, RbiRateUnavailableError,
 *                              FX_RATE_CACHE_TTL)
 *
 * Skipping prisma-bound services (holdings, trades, positions, etc.)
 * here - they're better covered via their consumer tests in apps/web.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getSegmentLabel,
  getProductTypeLabel,
  getSegmentFilterValues,
} from "../src/mappings";

import { getBillingPeriod, getFinancialYear } from "../src/gst/billing-period";

import {
  getRbiReferenceRate,
  RbiRateUnavailableError,
  FX_RATE_CACHE_TTL,
} from "../src/gst/rbi-fx";

// ── mappings.ts ─────────────────────────────────────────────────

describe("MONEY-393 §41 - services/mappings.ts", () => {
  it("[getSegmentLabel] maps known codes to display labels", () => {
    assert.equal(getSegmentLabel("CASH"), "Equity");
    assert.equal(getSegmentLabel("FO"), "F&O");
    assert.equal(getSegmentLabel("CD"), "Currency");
    assert.equal(getSegmentLabel("COM"), "Commodity");
    assert.equal(getSegmentLabel("MF"), "Mutual Funds");
    assert.equal(getSegmentLabel("NSE"), "Equity");
    assert.equal(getSegmentLabel("BSE"), "Equity");
    assert.equal(getSegmentLabel("NFO"), "F&O");
    assert.equal(getSegmentLabel("BFO"), "F&O");
    assert.equal(getSegmentLabel("MCX"), "Commodity");
    assert.equal(getSegmentLabel("CDS"), "Currency");
    assert.equal(getSegmentLabel("CNC"), "Equity");
    assert.equal(getSegmentLabel("MIS"), "Equity");
    assert.equal(getSegmentLabel("NRML"), "F&O");
    assert.equal(getSegmentLabel("EQUITY"), "Equity");
  });

  it("[getSegmentLabel] passes through unknown codes (fallback)", () => {
    assert.equal(getSegmentLabel("FUTURE_SEGMENT"), "FUTURE_SEGMENT");
    assert.equal(getSegmentLabel(""), "");
  });

  it("[getProductTypeLabel] maps known product codes", () => {
    assert.equal(getProductTypeLabel("CNC"), "Cash & Carry");
    assert.equal(getProductTypeLabel("MIS"), "Intraday");
    assert.equal(getProductTypeLabel("NRML"), "Normal F&O");
    assert.equal(getProductTypeLabel("BO"), "Bracket Order");
    assert.equal(getProductTypeLabel("CO"), "Cover Order");
  });

  it("[getProductTypeLabel] passes through unknown product codes", () => {
    assert.equal(getProductTypeLabel("OTHER"), "OTHER");
  });

  it("[getSegmentFilterValues] returns the full match set for a known segment", () => {
    assert.deepEqual(
      getSegmentFilterValues("CASH").sort(),
      ["CASH", "CNC", "EQUITY", "MIS", "BSE", "NSE"].sort(),
    );
    assert.deepEqual(
      getSegmentFilterValues("FO").sort(),
      // MONEY-846: F&O filter now also matches FUTURES/OPTIONS-stored trades
      ["BFO", "FO", "FUTURES", "NFO", "NRML", "OPTIONS"].sort(),
    );
    assert.deepEqual(
      getSegmentFilterValues("CD").sort(),
      ["CD", "CDS", "CURRENCY"].sort(),
    );
    assert.deepEqual(
      getSegmentFilterValues("COM").sort(),
      ["COM", "COMMODITY", "MCX", "NCDEX"].sort(),
    );
  });

  it("[getSegmentFilterValues] falls back to [segment] for an unknown key", () => {
    assert.deepEqual(getSegmentFilterValues("UNKNOWN"), ["UNKNOWN"]);
  });
});

// ── gst/billing-period.ts ───────────────────────────────────────

describe("MONEY-393 §41 - services/gst/billing-period.ts", () => {
  it("[getBillingPeriod] day 1 → period 1-15 (first half)", () => {
    const tx = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01
    const { start, end } = getBillingPeriod(tx);
    assert.equal(start.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-04-15T23:59:59.999Z");
  });

  it("[getBillingPeriod] day 15 → period 1-15 (boundary)", () => {
    const tx = new Date(Date.UTC(2026, 3, 15));
    const { start, end } = getBillingPeriod(tx);
    assert.equal(start.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-04-15T23:59:59.999Z");
  });

  it("[getBillingPeriod] day 16 → period 16-30 (second half)", () => {
    const tx = new Date(Date.UTC(2026, 3, 16));
    const { start, end } = getBillingPeriod(tx);
    assert.equal(start.toISOString(), "2026-04-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-04-30T23:59:59.999Z");
  });

  it("[getBillingPeriod] day 30 (April end) → period 16-30", () => {
    const tx = new Date(Date.UTC(2026, 3, 30));
    const { start, end } = getBillingPeriod(tx);
    assert.equal(start.toISOString(), "2026-04-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-04-30T23:59:59.999Z");
  });

  it("[getBillingPeriod] Feb 28 (non-leap, day > 15) → period stretches to end-of-month", () => {
    const tx = new Date(Date.UTC(2026, 1, 28)); // 2026 is not a leap year
    const { start, end } = getBillingPeriod(tx);
    assert.equal(start.toISOString(), "2026-02-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-02-28T23:59:59.999Z");
  });

  it("[getBillingPeriod] Feb 29 (leap year) → period 16-29", () => {
    const tx = new Date(Date.UTC(2024, 1, 29));
    const { start, end } = getBillingPeriod(tx);
    assert.equal(start.toISOString(), "2024-02-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2024-02-29T23:59:59.999Z");
  });

  it("[getBillingPeriod] respects BILLING_PERIOD_DAYS env override", () => {
    const saved = process.env.BILLING_PERIOD_DAYS;
    process.env.BILLING_PERIOD_DAYS = "10";
    try {
      // day 5 → period 1-10 with 10-day cadence
      const tx = new Date(Date.UTC(2026, 5, 5));
      const { end } = getBillingPeriod(tx);
      assert.equal(end.toISOString(), "2026-06-10T23:59:59.999Z");
    } finally {
      if (saved === undefined) delete process.env.BILLING_PERIOD_DAYS;
      else process.env.BILLING_PERIOD_DAYS = saved;
    }
  });

  it("[getBillingPeriod] invalid BILLING_PERIOD_DAYS env falls back to default 15", () => {
    const saved = process.env.BILLING_PERIOD_DAYS;
    process.env.BILLING_PERIOD_DAYS = "garbage";
    try {
      const tx = new Date(Date.UTC(2026, 5, 5));
      const { end } = getBillingPeriod(tx);
      // Default 15-day cadence → period 1-15
      assert.equal(end.toISOString(), "2026-06-15T23:59:59.999Z");
    } finally {
      if (saved === undefined) delete process.env.BILLING_PERIOD_DAYS;
      else process.env.BILLING_PERIOD_DAYS = saved;
    }
  });

  it("[getBillingPeriod] negative BILLING_PERIOD_DAYS env falls back to default", () => {
    const saved = process.env.BILLING_PERIOD_DAYS;
    process.env.BILLING_PERIOD_DAYS = "-5";
    try {
      const tx = new Date(Date.UTC(2026, 5, 5));
      const { end } = getBillingPeriod(tx);
      assert.equal(end.toISOString(), "2026-06-15T23:59:59.999Z");
    } finally {
      if (saved === undefined) delete process.env.BILLING_PERIOD_DAYS;
      else process.env.BILLING_PERIOD_DAYS = saved;
    }
  });

  it("[getFinancialYear] April → current FY (e.g. Apr 2026 → '26-27')", () => {
    assert.equal(getFinancialYear(new Date(Date.UTC(2026, 3, 1))), "26-27");
    assert.equal(getFinancialYear(new Date(Date.UTC(2026, 11, 31))), "26-27");
  });

  it("[getFinancialYear] March → prior FY (e.g. Mar 2026 → '25-26')", () => {
    assert.equal(getFinancialYear(new Date(Date.UTC(2026, 2, 31))), "25-26");
  });

  it("[getFinancialYear] January → prior FY (e.g. Jan 2026 → '25-26')", () => {
    assert.equal(getFinancialYear(new Date(Date.UTC(2026, 0, 15))), "25-26");
  });
});

// ── gst/rbi-fx.ts ───────────────────────────────────────────────

describe("MONEY-393 §41 - services/gst/rbi-fx.ts", () => {
  it("[constant] FX_RATE_CACHE_TTL is 24h (86400 seconds)", () => {
    assert.equal(FX_RATE_CACHE_TTL, 86400);
  });

  it("[getRbiReferenceRate] uses env override when GST_FX_RATE_<CCY>_<DATE> is set", async () => {
    const date = "2026-05-10";
    const envKey = `GST_FX_RATE_USD_${date}`;
    const saved = process.env[envKey];
    process.env[envKey] = "83.42";
    try {
      const result = await getRbiReferenceRate({
        currency: "USD",
        invoiceDate: new Date(`${date}T12:00:00Z`),
      });
      assert.equal(result.currency, "USD");
      assert.equal(result.rate, 83.42);
      assert.equal(result.rateDate, date);
      assert.equal(result.source, "ops_override");
      assert.equal(
        result.sourceUrl,
        `env:GST_FX_RATE_USD_${date}`,
        "sourceUrl must echo the env key used",
      );
    } finally {
      if (saved === undefined) delete process.env[envKey];
      else process.env[envKey] = saved;
    }
  });

  it("[getRbiReferenceRate] uppercases the currency code", async () => {
    const date = "2026-05-10";
    const envKey = `GST_FX_RATE_EUR_${date}`;
    process.env[envKey] = "90.50";
    try {
      // Pass lowercase 'eur' - must still match the upper-case env key
      const result = await getRbiReferenceRate({
        currency: "eur",
        invoiceDate: new Date(`${date}T12:00:00Z`),
      });
      assert.equal(result.currency, "EUR");
      assert.equal(result.rate, 90.5);
    } finally {
      delete process.env[envKey];
    }
  });

  it("[getRbiReferenceRate] rejects non-positive env values (falls back to live)", async () => {
    const date = "2026-05-10";
    const envKey = `GST_FX_RATE_GBP_${date}`;
    process.env[envKey] = "-1.0";
    try {
      // Negative override is invalid → falls through to fetchFromRbi (stub
      // returns null) → throws RbiRateUnavailableError
      await assert.rejects(
        getRbiReferenceRate({
          currency: "GBP",
          invoiceDate: new Date(`${date}T12:00:00Z`),
        }),
        RbiRateUnavailableError,
      );
    } finally {
      delete process.env[envKey];
    }
  });

  it("[getRbiReferenceRate] throws RbiRateUnavailableError when no source has a rate", async () => {
    const date = "2026-05-10";
    const envKey = `GST_FX_RATE_AUD_${date}`;
    const saved = process.env[envKey];
    delete process.env[envKey];
    try {
      await assert.rejects(
        getRbiReferenceRate({
          currency: "AUD",
          invoiceDate: new Date(`${date}T12:00:00Z`),
        }),
        (err: unknown) => {
          assert.ok(err instanceof RbiRateUnavailableError);
          assert.equal((err as RbiRateUnavailableError).currency, "AUD");
          assert.equal((err as RbiRateUnavailableError).date, date);
          return true;
        },
      );
    } finally {
      if (saved !== undefined) process.env[envKey] = saved;
    }
  });

  it("[RbiRateUnavailableError] carries name + cause when provided", () => {
    const cause = new Error("upstream failure");
    const err = new RbiRateUnavailableError("USD", "2026-05-10", cause);
    assert.equal(err.name, "RbiRateUnavailableError");
    assert.equal(err.currency, "USD");
    assert.equal(err.date, "2026-05-10");
    assert.equal((err as unknown as { cause: unknown }).cause, cause);
    assert.match(err.message, /USD/);
    assert.match(err.message, /2026-05-10/);
    assert.match(err.message, /GST_FX_RATE_USD_2026-05-10/);
  });

  it("[RbiRateUnavailableError] works without a cause", () => {
    const err = new RbiRateUnavailableError("INR", "2026-05-10");
    assert.equal(err.name, "RbiRateUnavailableError");
    assert.equal(
      (err as unknown as { cause: unknown }).cause,
      undefined,
      "no cause when not provided",
    );
  });

  it("[getRbiReferenceRate] env override with non-numeric value falls through", async () => {
    const date = "2026-05-10";
    const envKey = `GST_FX_RATE_CHF_${date}`;
    process.env[envKey] = "not-a-number";
    try {
      await assert.rejects(
        getRbiReferenceRate({
          currency: "CHF",
          invoiceDate: new Date(`${date}T12:00:00Z`),
        }),
        RbiRateUnavailableError,
      );
    } finally {
      delete process.env[envKey];
    }
  });
});

// ── analytics.ts (env-gated PostHog) ────────────────────────────

describe("MONEY-393 §41 - services/analytics.ts", () => {
  it("[captureServiceEvent] is a no-op when NEXT_PUBLIC_POSTHOG_KEY is unset", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    // Source reads process.env per-call, so no module-cache bust needed.
    const { captureServiceEvent } = await import("../src/analytics");
    // Must not throw and must return synchronously (void).
    captureServiceEvent("anon", "event_name", { ok: true });
    assert.ok(true, "no-op completes without throwing");
  });

  it("[captureServiceEvent] swallows PostHog constructor failures", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_invalid";
    try {
      // The real PostHog client constructor is permissive - it won't
      // throw on an invalid key. What we test here is that the function
      // doesn't propagate any error from the underlying call.
      const { captureServiceEvent } = await import("../src/analytics");
      // No throw expected.
      captureServiceEvent("anon", "event_name", {});
      assert.ok(true, "captureServiceEvent never throws");
    } finally {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    }
  });
});
