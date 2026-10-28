/**
 * Kite timestamp parsing — MONEY-582b.
 *
 * kite-time.ts is dependency-free, so unlike most broker tests this imports the
 * real implementation directly (no inline-copy, no drift).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseKiteTimestamp,
  kiteTradeDate,
} from "../../lib/brokers/clients/kite-time";

describe("parseKiteTimestamp (MONEY-582b IST correctness)", () => {
  it("parses a Kite IST wall-clock string as +05:30, not host-UTC", () => {
    // "2024-06-13 09:18:18" IST == 2024-06-13T03:48:18Z. The old
    // `new Date("2024-06-13 09:18:18")` parsed it as host-UTC (09:18:18Z) on
    // Vercel/Cloud Run — 5.5h early.
    const d = parseKiteTimestamp("2024-06-13 09:18:18");
    assert.ok(d);
    assert.equal(d!.toISOString(), "2024-06-13T03:48:18.000Z");
  });

  it("9:18 IST is NOT stored 5.5h early (regression guard)", () => {
    const d = parseKiteTimestamp("2024-06-13 09:18:18")!;
    // The drift bug produced 09:18Z; correct is 03:48Z.
    assert.notEqual(d.getUTCHours(), 9, "must not be the buggy UTC-9:18");
    assert.equal(d.getUTCHours(), 3);
    assert.equal(d.getUTCMinutes(), 48);
  });

  it("falls back through the candidate chain when earlier fields are empty", () => {
    const d = parseKiteTimestamp(undefined, "", "2024-01-02 10:00:00");
    assert.ok(d);
    assert.equal(d!.toISOString(), "2024-01-02T04:30:00.000Z");
  });

  it("trusts an explicit Z zone as-is", () => {
    const d = parseKiteTimestamp("2024-06-13T03:48:18Z");
    assert.equal(d!.toISOString(), "2024-06-13T03:48:18.000Z");
  });

  it("trusts an explicit +HH:MM offset as-is (no double-applied IST)", () => {
    const d = parseKiteTimestamp("2024-06-13T09:18:18+05:30");
    assert.equal(d!.toISOString(), "2024-06-13T03:48:18.000Z");
  });

  it("returns null when no candidate is valid (caller picks the fallback)", () => {
    assert.equal(parseKiteTimestamp(undefined, null, "", "not-a-date"), null);
  });

  it("orders two same-day trades correctly after parsing (FIFO stability)", () => {
    const a = parseKiteTimestamp("2024-06-13 09:18:18")!;
    const b = parseKiteTimestamp("2024-06-13 14:05:00")!;
    assert.ok(a.getTime() < b.getTime(), "earlier IST trade sorts first");
  });
});

describe("kiteTradeDate (MONEY-582b)", () => {
  it("returns the IST calendar date from the wall-clock string", () => {
    assert.equal(kiteTradeDate("2024-06-13 09:18:18"), "2024-06-13");
  });

  it("does NOT roll to the previous day for an early-morning IST trade", () => {
    // 00:30 IST on the 13th is 19:00Z on the 12th — taking the date from the
    // raw IST string keeps it on the 13th (correct), unlike a UTC conversion.
    assert.equal(kiteTradeDate("2024-06-13 00:30:00"), "2024-06-13");
  });

  it("handles a T separator and a fallback chain", () => {
    assert.equal(kiteTradeDate(undefined, "2024-02-29T10:00:00"), "2024-02-29");
  });

  it("returns empty string when nothing is parseable", () => {
    assert.equal(kiteTradeDate(undefined, null, "garbage"), "");
  });
});
