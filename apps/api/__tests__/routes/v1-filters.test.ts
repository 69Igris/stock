/**
 * V1 Query-Filter Guard Tests (MONEY-1062)
 *
 * Exercises the REAL pure guards in `apps/api/src/routes/v1/filters.ts` — the
 * enum/date/FY validators the `trades` / `paired` / `positions` / `tax` routes
 * call BEFORE a query-string value reaches a Prisma enum/DateTime column or
 * tax-logic's `fyStartYear` (where garbage used to throw → 500). No inline
 * reimplementation. The route-level 400 wiring is covered by the HTTP contract
 * suites (portfolio-p2 / engagement-p4a / money1062-hardening); this file pins
 * the guard SEMANTICS: everything the downstream where-clause builders accept
 * must stay valid byte-for-byte, and only values that would throw are rejected.
 *
 * Source: apps/api/src/routes/v1/filters.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isValidBrokerFilter,
  isValidPairedStatusFilter,
  isParseableDate,
  isValidFinancialYear,
  BROKER_TYPE_VALUES,
  PAIRED_TRADE_STATUS_VALUES,
} from "../../src/routes/v1/filters";

// ── isValidBrokerFilter ──────────────────────────────────────────────────────

describe("isValidBrokerFilter", () => {
  it("accepts absent / empty (no filter — behaviour unchanged)", () => {
    assert.equal(isValidBrokerFilter(undefined), true);
    assert.equal(isValidBrokerFilter(""), true);
  });

  it("accepts the 'all' and 'manual' sentinels the where-builders honour", () => {
    assert.equal(isValidBrokerFilter("all"), true);
    assert.equal(isValidBrokerFilter("manual"), true);
  });

  it("accepts every canonical BrokerType enum value", () => {
    for (const broker of BROKER_TYPE_VALUES) {
      assert.equal(
        isValidBrokerFilter(broker),
        true,
        `${broker} must be valid`,
      );
    }
  });

  it("the canonical value list is the full 11-value BrokerType enum", () => {
    assert.deepEqual([...BROKER_TYPE_VALUES].sort(), [
      "ANGEL_ONE",
      "DHAN",
      "FYERS",
      "GROWW",
      "HDFC",
      "ICICI",
      "INTERACTIVE_BROKERS",
      "MANUAL",
      "UPSTOX",
      "ZERODHA",
      "ZERODHA_CONNECT",
    ]);
  });

  it("accepts the 'BROKER:brokerUserId' split form when the base is a real enum", () => {
    assert.equal(isValidBrokerFilter("ZERODHA:AB1234"), true);
    assert.equal(isValidBrokerFilter("UPSTOX:user-7"), true);
    // only the FIRST colon splits; the remainder is the opaque brokerUserId
    assert.equal(isValidBrokerFilter("DHAN:a:b"), true);
  });

  it("rejects a garbage value that would hit the Prisma enum validator", () => {
    assert.equal(isValidBrokerFilter("EVIL_BROKER"), false);
    assert.equal(isValidBrokerFilter("zerodha"), false); // case-sensitive enum
    assert.equal(isValidBrokerFilter("NOT_A_BROKER:AB1234"), false);
    assert.equal(isValidBrokerFilter(":AB1234"), false); // empty base
  });

  it("does NOT false-positive on Object prototype keys (array membership, not `in`)", () => {
    assert.equal(isValidBrokerFilter("constructor"), false);
    assert.equal(isValidBrokerFilter("toString"), false);
    assert.equal(isValidBrokerFilter("hasOwnProperty"), false);
    assert.equal(isValidBrokerFilter("__proto__"), false);
  });
});

// ── isValidPairedStatusFilter ────────────────────────────────────────────────

describe("isValidPairedStatusFilter", () => {
  it("accepts absent / empty / 'all' (unfiltered)", () => {
    assert.equal(isValidPairedStatusFilter(undefined), true);
    assert.equal(isValidPairedStatusFilter(""), true);
    assert.equal(isValidPairedStatusFilter("all"), true);
  });

  it("accepts exactly OPEN / CLOSED / PARTIAL", () => {
    assert.deepEqual([...PAIRED_TRADE_STATUS_VALUES].sort(), [
      "CLOSED",
      "OPEN",
      "PARTIAL",
    ]);
    for (const status of PAIRED_TRADE_STATUS_VALUES) {
      assert.equal(isValidPairedStatusFilter(status), true);
    }
  });

  it("rejects anything else (would throw on the Prisma enum column)", () => {
    assert.equal(isValidPairedStatusFilter("SIDEWAYS"), false);
    assert.equal(isValidPairedStatusFilter("open"), false); // case-sensitive
    assert.equal(isValidPairedStatusFilter("constructor"), false);
  });
});

// ── isParseableDate ──────────────────────────────────────────────────────────

describe("isParseableDate", () => {
  it("accepts absent / empty (services treat a falsy date as unset)", () => {
    assert.equal(isParseableDate(undefined), true);
    assert.equal(isParseableDate(""), true);
  });

  it("accepts real date strings (date-only and full ISO)", () => {
    assert.equal(isParseableDate("2026-01-01"), true);
    assert.equal(isParseableDate("2026-01-01T10:30:00.000Z"), true);
  });

  it("rejects a non-parseable string (Invalid Date would 500 in Prisma)", () => {
    assert.equal(isParseableDate("not-a-date"), false);
    assert.equal(isParseableDate("32-13-2026garbage"), false);
  });
});

// ── isValidFinancialYear ─────────────────────────────────────────────────────

describe("isValidFinancialYear", () => {
  it("accepts absent / empty (tax service defaults to the current FY)", () => {
    assert.equal(isValidFinancialYear(undefined), true);
    assert.equal(isValidFinancialYear(""), true);
  });

  it("accepts both label forms fyStartYear parses: YYYY-YY and YYYY-YYYY", () => {
    assert.equal(isValidFinancialYear("2024-25"), true);
    assert.equal(isValidFinancialYear("2024-2025"), true);
  });

  it("rejects malformed labels that make fyStartYear throw RangeError", () => {
    assert.equal(isValidFinancialYear("garbage"), false);
    assert.equal(isValidFinancialYear("FY2024-25"), false);
    assert.equal(isValidFinancialYear("2024"), false); // no end year
    assert.equal(isValidFinancialYear("2024-2"), false); // 1-digit end
    assert.equal(isValidFinancialYear("2024-256"), false); // 3-digit end
    assert.equal(isValidFinancialYear("24-25"), false); // 2-digit start
  });
});
