/**
 * Tests for Terminal Luxe primitives (MONEY-187).
 *
 * These cover the pure formatters and helpers exported from
 * `components/terminal-luxe/primitives.tsx`. The React components are
 * smoke-tested in the Holdings/Tradebook page tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  fmtINR,
  fmtINRSigned,
  fmtLakhs,
  toBrokerSlug,
} from "../../components/terminal-luxe/primitives";

describe("fmtINR", () => {
  test("formats positive amounts with no fractional digits", () => {
    assert.equal(fmtINR(1234), "₹1,234");
    assert.equal(fmtINR(1_234_567), "₹12,34,567");
  });

  test("supports configurable fractional digits", () => {
    assert.equal(fmtINR(1234.567, 2), "₹1,234.57");
  });

  test("uses absolute value (sign is owned by fmtINRSigned)", () => {
    assert.equal(fmtINR(-1234), "₹1,234");
  });

  test("returns ₹0 for zero", () => {
    assert.equal(fmtINR(0), "₹0");
  });
});

describe("fmtINRSigned", () => {
  test("prefixes plus for non-negative numbers", () => {
    assert.equal(fmtINRSigned(0), "+₹0");
    assert.equal(fmtINRSigned(5000), "+₹5,000");
  });

  test("prefixes the unicode minus for negative numbers", () => {
    // Note: uses U+2212 not ASCII hyphen - important for visual alignment.
    assert.equal(fmtINRSigned(-5000), "−₹5,000");
  });
});

describe("fmtLakhs", () => {
  test("renders crores", () => {
    assert.equal(fmtLakhs(1_50_00_000), "₹1.50 Cr");
  });

  test("renders lakhs", () => {
    assert.equal(fmtLakhs(1_25_000), "₹1.25 L");
  });

  test("renders thousands with one decimal", () => {
    assert.equal(fmtLakhs(12_500), "₹12.5K");
  });

  test("renders raw rupees below 1000", () => {
    assert.equal(fmtLakhs(842), "₹842");
  });
});

describe("toBrokerSlug", () => {
  test("maps known BrokerType enums to lowercase asset slugs", () => {
    assert.equal(toBrokerSlug("ZERODHA"), "zerodha");
    assert.equal(toBrokerSlug("UPSTOX"), "upstox");
    assert.equal(toBrokerSlug("ANGEL_ONE"), "angel"); // enum name → asset name
    assert.equal(toBrokerSlug("HDFC"), "hdfc");
  });

  test("falls back to lowercased value for unknown brokers", () => {
    assert.equal(toBrokerSlug("CUSTOM_BROKER"), "custom_broker");
  });

  test("returns 'manual' for null/undefined inputs", () => {
    assert.equal(toBrokerSlug(null), "manual");
    assert.equal(toBrokerSlug(undefined), "manual");
  });
});
