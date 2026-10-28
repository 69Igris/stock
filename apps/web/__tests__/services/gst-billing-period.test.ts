import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBillingPeriod, getFinancialYear } from "@usemoney/services/gst";

describe("getBillingPeriod", () => {
  it("places a 1st-of-month txn into the first half period", () => {
    const tx = new Date("2026-04-01T10:00:00Z");
    const { start, end } = getBillingPeriod(tx);
    assert.equal(start.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-04-15T23:59:59.999Z");
  });

  it("places the 15th-of-month txn into the first half period", () => {
    const { start, end } = getBillingPeriod(new Date("2026-04-15T23:30:00Z"));
    assert.equal(start.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-04-15T23:59:59.999Z");
  });

  it("places the 16th-of-month txn into the second half period", () => {
    const { start, end } = getBillingPeriod(new Date("2026-04-16T00:30:00Z"));
    assert.equal(start.toISOString(), "2026-04-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-04-30T23:59:59.999Z");
  });

  it("handles February (28 days) - second half ends on the 28th", () => {
    const { start, end } = getBillingPeriod(new Date("2027-02-20T12:00:00Z"));
    assert.equal(start.toISOString(), "2027-02-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2027-02-28T23:59:59.999Z");
  });

  it("handles leap February (29 days) - second half ends on the 29th", () => {
    const { start, end } = getBillingPeriod(new Date("2028-02-25T12:00:00Z"));
    assert.equal(start.toISOString(), "2028-02-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2028-02-29T23:59:59.999Z");
  });

  it("handles 31-day months - second half ends on the 31st", () => {
    const { start, end } = getBillingPeriod(new Date("2026-03-31T18:00:00Z"));
    assert.equal(start.toISOString(), "2026-03-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-03-31T23:59:59.999Z");
  });
});

describe("getFinancialYear", () => {
  it("April 1 starts a new FY", () => {
    assert.equal(getFinancialYear(new Date("2026-04-01T00:00:00Z")), "26-27");
  });

  it("March 31 still belongs to prior FY", () => {
    assert.equal(getFinancialYear(new Date("2026-03-31T23:59:59Z")), "25-26");
  });

  it("January 1 belongs to prior FY", () => {
    assert.equal(getFinancialYear(new Date("2027-01-01T00:00:00Z")), "26-27");
  });

  it("December 31 belongs to current FY", () => {
    assert.equal(getFinancialYear(new Date("2026-12-31T23:59:59Z")), "26-27");
  });
});
