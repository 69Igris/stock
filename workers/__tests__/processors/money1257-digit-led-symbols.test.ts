/**
 * Digit-leading COMPANY symbols are researchable; digit-leading DEBT is not —
 * MONEY-1257.
 *
 * `VALID_EQUITY_PATTERN` anchors on `^[A-Z]`, which silently excluded 3,791
 * symbols from the document sync. Among them: 3MINDIA, 5PAISA, 360ONE,
 * 63MOONS, 20MICRONS — listed companies with a decade of annual reports sitting
 * on screener.in that we could never fetch.
 *
 * ## Why the obvious fix is the wrong one
 *
 * Loosening the anchor to `^[A-Z0-9]` looks like a one-character win. Measured
 * on prod, it admits 3,791 symbols of which **25** carry a company ISIN and
 * **3,766** are debt instruments — `07QPD`, `09AMR`, `07BPB` — with no ISIN at
 * all.
 *
 * That trade is negative, and worse than it sounds. The rotation is symbol-
 * ordered and its head is ALREADY 11,110 non-equity rows (state government
 * paper: `747UK34-SG`, `748AP33-SG`). Digits sort before letters, so 3,766 new
 * junk rows would lead the queue for weeks, ahead of every real company. The
 * fix for "we are missing 25 companies" would have delayed the other 5,498.
 *
 * The ISIN is the discriminator. It is the exchange's own answer to "is this an
 * equity", and the page query already selects it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isValidEquitySymbol } from "../../src/processors/stock-document-sync-logic";

describe("digit-leading symbols are gated on a company ISIN (MONEY-1257)", () => {
  it("admits digit-led symbols that carry an INE company ISIN", () => {
    // Every one of these is a real listed company that the sync could not see.
    for (const [symbol, isin] of [
      ["3MINDIA", "INE470A01017"],
      ["5PAISA", "INE618L01018"],
      ["360ONE", "INE466L01038"],
      ["63MOONS", "INE111B01023"],
      ["20MICRONS", "INE144J01027"],
    ] as const) {
      assert.equal(
        isValidEquitySymbol(symbol, isin),
        true,
        `${symbol} is a listed company and must be researchable`
      );
    }
  });

  it("still refuses digit-led DEBT, which has no ISIN", () => {
    // The 3,766 a bare `^[A-Z0-9]` would have re-admitted.
    for (const symbol of ["07QPD", "09AMR", "07BPB", "09QPR", "07ABB"]) {
      assert.equal(
        isValidEquitySymbol(symbol, null),
        false,
        `${symbol} carries no ISIN and must not enter the rotation`
      );
    }
  });

  it("refuses a digit-led symbol whose ISIN is GOVERNMENT, not company", () => {
    // The discriminator is the INE prefix, not merely "has an ISIN" — state
    // paper does carry one.
    assert.equal(isValidEquitySymbol("748AP33", "IN1920190145"), false);
  });

  it("refuses a digit-led symbol with no ISIN even if it names a real company", () => {
    // Fail CLOSED. An unresolved ISIN means we cannot tell, and admitting on a
    // maybe is how 3,766 debt rows get in.
    assert.equal(isValidEquitySymbol("3MINDIA", null), false);
    assert.equal(isValidEquitySymbol("3MINDIA", undefined), false);
  });

  it("leaves ordinary letter-led symbols exactly as they were", () => {
    // The change must be additive. An ISIN is not required for these, because
    // the shape alone has always been sufficient.
    for (const symbol of ["RELIANCE", "HAWKINCOOK", "TCS", "GOODYEAR"]) {
      assert.equal(isValidEquitySymbol(symbol), true, `${symbol} regressed`);
      assert.equal(isValidEquitySymbol(symbol, null), true, `${symbol} regressed`);
    }
  });

  it("still refuses state-government paper on SHAPE alone", () => {
    // These lead the rotation today. The hyphen is absent from the character
    // class, so they fail before the ISIN is ever consulted — which is what
    // keeps this fix from re-opening the queue-clogging class.
    for (const symbol of ["747UK34-SG", "748AP33-SG", "748AP38A-SG"]) {
      assert.equal(isValidEquitySymbol(symbol, "INE470A01017"), false);
    }
  });
});
