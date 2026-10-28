import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTaxBreakdown,
  userGstProfileSchema,
  GST_PROFILE_REGEXES,
} from "@usemoney/services/gst";

/**
 * Pure-logic tests for MONEY-227 (domestic invoice path).
 * The engine's DB-touching path lives in integration suite; here we cover:
 *   - Tax-split rule (intra-state CGST+SGST vs inter-state IGST)
 *   - GSTIN/PAN/state-code format validation
 *   - User profile Zod schema (round-trip + rejections)
 */

describe("computeTaxBreakdown - place-of-supply rule", () => {
  it("intra-state (buyer == seller): splits as CGST + SGST equally", () => {
    const t = computeTaxBreakdown({
      taxableValueInr: 1000,
      buyerStateCode: "27",
      sellerStateCode: "27",
      ratePercent: 18,
    });
    assert.equal(t.cgstRate, 9);
    assert.equal(t.sgstRate, 9);
    assert.equal(t.igstRate, 0);
    assert.equal(t.cgstAmountInr, 90);
    assert.equal(t.sgstAmountInr, 90);
    assert.equal(t.igstAmountInr, 0);
    assert.equal(t.totalTaxInr, 180);
  });

  it("inter-state (buyer != seller): puts full rate on IGST", () => {
    const t = computeTaxBreakdown({
      taxableValueInr: 1000,
      buyerStateCode: "29",
      sellerStateCode: "27",
      ratePercent: 18,
    });
    assert.equal(t.cgstAmountInr, 0);
    assert.equal(t.sgstAmountInr, 0);
    assert.equal(t.igstRate, 18);
    assert.equal(t.igstAmountInr, 180);
    assert.equal(t.totalTaxInr, 180);
  });

  it("missing buyer state defaults to inter-state (safer for compliance)", () => {
    const t = computeTaxBreakdown({
      taxableValueInr: 100,
      buyerStateCode: "",
      sellerStateCode: "27",
      ratePercent: 18,
    });
    assert.equal(t.igstRate, 18);
    assert.equal(t.cgstRate, 0);
  });

  it("custom rate (e.g. 5% essential service) flows through", () => {
    const t = computeTaxBreakdown({
      taxableValueInr: 1000,
      buyerStateCode: "27",
      sellerStateCode: "27",
      ratePercent: 5,
    });
    assert.equal(t.cgstRate, 2.5);
    assert.equal(t.sgstRate, 2.5);
    assert.equal(t.cgstAmountInr, 25);
    assert.equal(t.sgstAmountInr, 25);
    assert.equal(t.totalTaxInr, 50);
  });

  it("zero taxable value produces zero tax (no division-by-zero)", () => {
    const t = computeTaxBreakdown({
      taxableValueInr: 0,
      buyerStateCode: "27",
      sellerStateCode: "27",
    });
    assert.equal(t.totalTaxInr, 0);
  });
});

describe("userGstProfileSchema - Zod validation", () => {
  it("accepts a valid B2B profile with GSTIN", () => {
    const parsed = userGstProfileSchema.parse({
      legalName: "Acme Investments Pvt Ltd",
      address: "123 MG Road, Mumbai 400001",
      stateCode: "27",
      gstin: "27ABCDE1234F1Z5",
    });
    assert.equal(parsed.gstin, "27ABCDE1234F1Z5");
  });

  it("accepts a B2C profile (no GSTIN)", () => {
    const parsed = userGstProfileSchema.parse({
      legalName: "Rohan Sharma",
      address: "Plot 42, Sector 5, Noida 201301",
      stateCode: "09",
    });
    assert.equal(parsed.gstin, undefined);
  });

  it("rejects malformed GSTIN", () => {
    assert.throws(() =>
      userGstProfileSchema.parse({
        legalName: "Acme",
        address: "long enough address line here",
        stateCode: "27",
        gstin: "INVALID-GSTIN",
      })
    );
  });

  it("rejects malformed PAN", () => {
    assert.throws(() =>
      userGstProfileSchema.parse({
        legalName: "Acme",
        address: "long enough address line here",
        stateCode: "27",
        pan: "BADPAN",
      })
    );
  });

  it("rejects state codes outside 01-37", () => {
    assert.throws(() =>
      userGstProfileSchema.parse({
        legalName: "Acme",
        address: "long enough address line here",
        stateCode: "99",
      })
    );
    assert.throws(() =>
      userGstProfileSchema.parse({
        legalName: "Acme",
        address: "long enough address line here",
        stateCode: "00",
      })
    );
  });

  it("rejects too-short legal name", () => {
    assert.throws(() =>
      userGstProfileSchema.parse({
        legalName: "X",
        address: "long enough address line here",
        stateCode: "27",
      })
    );
  });

  it("rejects too-short address", () => {
    assert.throws(() =>
      userGstProfileSchema.parse({
        legalName: "Acme",
        address: "short",
        stateCode: "27",
      })
    );
  });

  it("uppercases GSTIN automatically (via Zod toUpperCase chain)", () => {
    const parsed = userGstProfileSchema.parse({
      legalName: "Acme",
      address: "long enough address line here",
      stateCode: "27",
      gstin: "27abcde1234f1z5",
    });
    assert.equal(parsed.gstin, "27ABCDE1234F1Z5");
  });

  it("accepts empty-string GSTIN as 'not provided'", () => {
    const parsed = userGstProfileSchema.parse({
      legalName: "Acme",
      address: "long enough address line here",
      stateCode: "27",
      gstin: "",
    });
    assert.equal(parsed.gstin, "");
  });
});

describe("GST_PROFILE_REGEXES - exposed for UI client-side hints", () => {
  it("GSTIN pattern accepts canonical format", () => {
    assert.ok(GST_PROFILE_REGEXES.GSTIN.test("27ABCDE1234F1Z5"));
  });

  it("GSTIN pattern rejects extra characters", () => {
    assert.ok(!GST_PROFILE_REGEXES.GSTIN.test("27ABCDE1234F1Z5X"));
  });

  it("PAN pattern accepts canonical format", () => {
    assert.ok(GST_PROFILE_REGEXES.PAN.test("ABCDE1234F"));
  });

  it("STATE_CODE accepts 01–37 only", () => {
    assert.ok(GST_PROFILE_REGEXES.STATE_CODE.test("27"));
    assert.ok(GST_PROFILE_REGEXES.STATE_CODE.test("01"));
    assert.ok(GST_PROFILE_REGEXES.STATE_CODE.test("37"));
    assert.ok(!GST_PROFILE_REGEXES.STATE_CODE.test("38"));
    assert.ok(!GST_PROFILE_REGEXES.STATE_CODE.test("00"));
  });
});
