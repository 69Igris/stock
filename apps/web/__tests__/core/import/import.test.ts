/**
 * Core Import Module Tests (packages/core/src/import/)
 *
 * DE-SHADOWED (MONEY-620): this file previously RE-IMPLEMENTED every parser
 * inline and asserted the copy — a shadow that could stay green while the real
 * import engine broke. It now imports the REAL exported symbols from
 * `@usemoney/core/import` so a regression in the shipped code fails here.
 *
 * Covers:
 *   - normalizeTradeType / normalizeExchange / normalizeSegment / parseNumber /
 *     normalizeColumnName
 *   - parseDate / parseDateTime
 *   - generateDuplicateHash (canonical 7-field)
 *   - sanitizeFormulaInjection (formula-injection: =, +, -, @)
 *   - detectDelimiter / findHeaderRow / parseCSVContent
 *   - getColumnMapping (8 broker formats) + parseCSVRow per-row validation
 *   - ISIN detection (exercised through parseCSVRow on the real source)
 *
 * Plus NEGATIVE + EDGE cases: formula-injection rows, unicode/BOM, negative
 * qty/price, NaN, empty file, header-row-not-found, delimiter ambiguity,
 * duplicate-priority collision, malformed/unparseable dates.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  normalizeColumnName,
  normalizeTradeType,
  normalizeExchange,
  normalizeSegment,
  parseNumber,
  parseDate,
  parseDateTime,
  generateDuplicateHash,
  sanitizeFormulaInjection,
  detectDelimiter,
  findHeaderRow,
  parseCSVContent,
  parseCSVRow,
  getColumnMapping,
  type BrokerFormat,
} from "@usemoney/core/import";

describe("Core Import Module (real source)", () => {
  // ── normalizeTradeType ──

  describe("normalizeTradeType", () => {
    it("normalizes BUY variations", () => {
      assert.equal(normalizeTradeType("BUY"), "BUY");
      assert.equal(normalizeTradeType("B"), "BUY");
      assert.equal(normalizeTradeType("BOUGHT"), "BUY");
      assert.equal(normalizeTradeType("PURCHASE"), "BUY");
      assert.equal(normalizeTradeType("1"), "BUY");
      assert.equal(normalizeTradeType("buy"), "BUY");
      assert.equal(normalizeTradeType("  Buy  "), "BUY");
    });

    it("normalizes SELL variations", () => {
      assert.equal(normalizeTradeType("SELL"), "SELL");
      assert.equal(normalizeTradeType("S"), "SELL");
      assert.equal(normalizeTradeType("SOLD"), "SELL");
      assert.equal(normalizeTradeType("SALE"), "SELL");
      assert.equal(normalizeTradeType("-1"), "SELL");
      assert.equal(normalizeTradeType("2"), "SELL");
      assert.equal(normalizeTradeType("sell"), "SELL");
    });

    it("defaults unknown / empty / whitespace types to SELL", () => {
      assert.equal(normalizeTradeType("UNKNOWN"), "SELL");
      assert.equal(normalizeTradeType(""), "SELL");
      assert.equal(normalizeTradeType("   "), "SELL");
    });
  });

  // ── normalizeExchange ──

  describe("normalizeExchange", () => {
    it("normalizes known exchanges", () => {
      assert.equal(normalizeExchange("NSE"), "NSE");
      assert.equal(normalizeExchange("nse"), "NSE");
      assert.equal(normalizeExchange("BSE"), "BSE");
      assert.equal(normalizeExchange("NFO"), "NFO");
      assert.equal(normalizeExchange("MCX"), "MCX");
      assert.equal(normalizeExchange("CDS"), "CDS");
      assert.equal(normalizeExchange("BFO"), "BFO");
    });

    it("handles exchange names containing the acronym", () => {
      assert.equal(normalizeExchange("NSE_EQ"), "NSE");
      assert.equal(normalizeExchange("BSE_FO"), "BSE");
    });

    it("defaults empty string to NSE", () => {
      assert.equal(normalizeExchange(""), "NSE");
    });

    it("passes through unknown exchanges as uppercase", () => {
      assert.equal(normalizeExchange("otc"), "OTC");
    });
  });

  // ── normalizeSegment ──

  describe("normalizeSegment", () => {
    it("normalizes equity segments", () => {
      assert.equal(normalizeSegment("EQUITY", "NSE"), "EQUITY");
      assert.equal(normalizeSegment("EQ", "NSE"), "EQUITY");
      assert.equal(normalizeSegment("CASH", "NSE"), "EQUITY");
    });

    it("normalizes F&O segments", () => {
      assert.equal(normalizeSegment("FO", "NSE"), "FO");
      assert.equal(normalizeSegment("F&O", "NSE"), "FO");
      assert.equal(normalizeSegment("DERIVATIVE", "NSE"), "FO");
    });

    it("normalizes MF segments", () => {
      assert.equal(normalizeSegment("MF", "NSE"), "MF");
      assert.equal(normalizeSegment("MUTUAL FUND", "NSE"), "MF");
    });

    it("normalizes currency segments", () => {
      assert.equal(normalizeSegment("CD", "NSE"), "CURRENCY");
      assert.equal(normalizeSegment("CUR", "NSE"), "CURRENCY");
    });

    it("normalizes commodity segments", () => {
      assert.equal(normalizeSegment("COM", "NSE"), "COMMODITY");
      assert.equal(normalizeSegment("MCX", "NSE"), "COMMODITY");
    });

    it("derives segment from exchange when segment is empty", () => {
      assert.equal(normalizeSegment("", "NFO"), "FO");
      assert.equal(normalizeSegment("", "BFO"), "FO");
      assert.equal(normalizeSegment("", "MF"), "MF");
      assert.equal(normalizeSegment("", "MCX"), "COMMODITY");
      assert.equal(normalizeSegment("", "CDS"), "CURRENCY");
    });

    it("defaults to EQUITY when segment and exchange are generic", () => {
      assert.equal(normalizeSegment("", "NSE"), "EQUITY");
      assert.equal(normalizeSegment("UNKNOWN", "NSE"), "EQUITY");
    });
  });

  // ── parseNumber ──

  describe("parseNumber", () => {
    it("parses numeric values", () => {
      assert.equal(parseNumber(100), 100);
      assert.equal(parseNumber("100.50"), 100.5);
      assert.equal(parseNumber("1,500.00"), 1500);
    });

    it("strips currency symbols", () => {
      assert.equal(parseNumber("₹1500"), 1500);
      assert.equal(parseNumber("$100.50"), 100.5);
    });

    it("returns 0 for invalid string / null / undefined / object", () => {
      assert.equal(parseNumber("abc"), 0);
      assert.equal(parseNumber(null), 0);
      assert.equal(parseNumber(undefined), 0);
      assert.equal(parseNumber({}), 0);
      assert.equal(parseNumber(""), 0);
    });

    it("keeps negative numbers as-is (sign preserved)", () => {
      assert.equal(parseNumber("-100.50"), -100.5);
      assert.equal(parseNumber(-42), -42);
    });

    it("parenthesised negatives are NOT parsed as negative (returns 0)", () => {
      // Accounting-style "(1500)" has no leading minus; parseFloat sees "(1500)"
      // ⇒ NaN ⇒ 0. Pinning current behavior so a future change is intentional.
      assert.equal(parseNumber("(1500)"), 0);
    });

    it("BUG-FIX guard: non-finite NUMBER inputs are clamped to 0 (no NaN/Infinity leak)", () => {
      // Previously `typeof value === 'number'` returned NaN / ±Infinity verbatim,
      // poisoning qty/price math, dedup hashing and P&L. Now clamped to 0.
      assert.equal(parseNumber(NaN), 0);
      assert.equal(parseNumber(Infinity), 0);
      assert.equal(parseNumber(-Infinity), 0);
    });

    it("BUG-FIX guard: 'Infinity' STRING is clamped to 0", () => {
      // parseFloat("Infinity") === Infinity and isNaN(Infinity) === false, so the
      // old `isNaN` check let it through. Finiteness check now catches it.
      assert.equal(parseNumber("Infinity"), 0);
      assert.equal(parseNumber("-Infinity"), 0);
    });
  });

  // ── parseDate ──

  describe("parseDate", () => {
    it("parses ISO format (YYYY-MM-DD)", () => {
      const date = parseDate("2025-10-08");
      assert.ok(date);
      assert.equal(date.getFullYear(), 2025);
      assert.equal(date.getMonth(), 9); // 0-based
      assert.equal(date.getDate(), 8);
    });

    it("parses DD-MM-YYYY format", () => {
      const date = parseDate("08-10-2025");
      assert.ok(date);
      assert.equal(date.getFullYear(), 2025);
      assert.equal(date.getMonth(), 9);
      assert.equal(date.getDate(), 8);
    });

    it("parses DD/MM/YYYY format", () => {
      const date = parseDate("08/10/2025");
      assert.ok(date);
      assert.equal(date.getFullYear(), 2025);
      assert.equal(date.getMonth(), 9);
      assert.equal(date.getDate(), 8);
    });

    it("handles 2-digit years", () => {
      const date = parseDate("08/10/25");
      assert.ok(date);
      assert.equal(date.getFullYear(), 2025);
    });

    it("returns null for empty string", () => {
      assert.equal(parseDate(""), null);
    });

    it("returns null for whitespace-only string", () => {
      assert.equal(parseDate("   "), null);
    });

    it("returns null for unparseable garbage", () => {
      assert.equal(parseDate("not-a-date"), null);
      assert.equal(parseDate("garbage"), null);
    });

    it("returns null for an out-of-range ISO date (2025-13-45)", () => {
      // 13th month / 45th day: Date() rejects ⇒ null (not a silent rollover here,
      // because the ISO branch validates getTime()).
      assert.equal(parseDate("2025-13-45"), null);
    });

    it("DD/MM with day>31 rolls over via JS Date (documented quirk)", () => {
      // "32/01/2025" → new Date(2025, 0, 32) = 2025-02-01. The DMY branch does
      // not range-check the day; pin the real behavior so a future hardening is
      // a deliberate change rather than an accident.
      const d = parseDate("32/01/2025");
      assert.ok(d);
      assert.equal(d.getMonth(), 1); // February (rolled over)
      assert.equal(d.getDate(), 1);
    });
  });

  // ── parseDateTime ──

  describe("parseDateTime", () => {
    it("parses ISO datetime", () => {
      const date = parseDateTime("2025-10-08T14:30:00");
      assert.ok(date);
      assert.equal(date.getFullYear(), 2025);
    });

    it("parses YYYY-MM-DD HH:mm:ss", () => {
      const date = parseDateTime("2025-10-08 14:30:45");
      assert.ok(date);
      assert.equal(date.getHours(), 14);
      assert.equal(date.getMinutes(), 30);
      assert.equal(date.getSeconds(), 45);
    });

    it("returns null for empty string", () => {
      assert.equal(parseDateTime(""), null);
    });

    it("returns null for unparseable garbage", () => {
      assert.equal(parseDateTime("not-a-datetime"), null);
    });
  });

  // ── generateDuplicateHash ──

  describe("generateDuplicateHash", () => {
    const baseTrade = {
      symbol: "RELIANCE",
      tradeDate: new Date("2025-10-08"),
      tradeType: "BUY",
      quantity: 10,
      price: 2500.5,
      exchange: "NSE",
      segment: "EQUITY",
    };

    it("produces a 16-char hex string", () => {
      const hash = generateDuplicateHash(baseTrade);
      assert.equal(hash.length, 16);
      assert.match(hash, /^[a-f0-9]{16}$/);
    });

    it("matches the exact canonical 7-field SHA-256 contract", () => {
      // Pin the WIRE contract, not just self-consistency: the hash MUST equal
      // SHA256(symbol|YYYY-MM-DD|type|qty|price2dp|exch|seg).slice(0,16).
      const expected = crypto
        .createHash("sha256")
        .update("RELIANCE|2025-10-08|BUY|10|2500.50|NSE|EQUITY")
        .digest("hex")
        .substring(0, 16);
      assert.equal(generateDuplicateHash(baseTrade), expected);
    });

    it("is deterministic", () => {
      assert.equal(
        generateDuplicateHash(baseTrade),
        generateDuplicateHash(baseTrade)
      );
    });

    it("every field changes the hash (collision-avoidance)", () => {
      const base = generateDuplicateHash(baseTrade);
      assert.notEqual(
        base,
        generateDuplicateHash({ ...baseTrade, segment: "FO" })
      );
      assert.notEqual(
        base,
        generateDuplicateHash({ ...baseTrade, symbol: "TCS" })
      );
      assert.notEqual(
        base,
        generateDuplicateHash({
          ...baseTrade,
          tradeDate: new Date("2025-10-09"),
        })
      );
      assert.notEqual(
        base,
        generateDuplicateHash({ ...baseTrade, tradeType: "SELL" })
      );
      assert.notEqual(
        base,
        generateDuplicateHash({ ...baseTrade, quantity: 20 })
      );
      assert.notEqual(
        base,
        generateDuplicateHash({ ...baseTrade, price: 2501.0 })
      );
      assert.notEqual(
        base,
        generateDuplicateHash({ ...baseTrade, exchange: "BSE" })
      );
    });

    it("defaults exchange→NSE and segment→EQUITY", () => {
      const withDefaults = generateDuplicateHash({
        symbol: "RELIANCE",
        tradeDate: new Date("2025-10-08"),
        tradeType: "BUY",
        quantity: 10,
        price: 2500.5,
      });
      assert.equal(withDefaults, generateDuplicateHash(baseTrade));
    });

    it("normalizes symbol & tradeType to uppercase, price to 2dp", () => {
      assert.equal(
        generateDuplicateHash(baseTrade),
        generateDuplicateHash({ ...baseTrade, symbol: "reliance" })
      );
      assert.equal(
        generateDuplicateHash(baseTrade),
        generateDuplicateHash({ ...baseTrade, tradeType: "buy" })
      );
      assert.equal(
        generateDuplicateHash(baseTrade),
        generateDuplicateHash({ ...baseTrade, price: 2500.50000001 })
      );
    });

    it("duplicate-priority collision: SYNCED vs IMPORTED with identical fields hash equal", () => {
      // The dedup engine keys purely on the 7 trade fields — source (SYNCED /
      // IMPORTED / MANUAL) is intentionally NOT part of the fingerprint, so the
      // same fill from two sources collides and is caught as a duplicate.
      const synced = generateDuplicateHash(baseTrade);
      const imported = generateDuplicateHash({ ...baseTrade });
      assert.equal(synced, imported);
    });

    it("BUG-FIX guard: an INVALID Date no longer throws (stable sentinel hash)", () => {
      // Previously `.toISOString()` threw 'Invalid time value' on a NaN-time
      // Date, crashing the whole import/dedup batch on one bad row. Now it
      // returns a deterministic 16-char hash via the INVALID_DATE sentinel.
      let hash = "";
      assert.doesNotThrow(() => {
        hash = generateDuplicateHash({
          symbol: "X",
          tradeDate: new Date("garbage"),
          tradeType: "BUY",
          quantity: 10,
          price: 100,
        });
      });
      assert.match(hash, /^[a-f0-9]{16}$/);
      // Two invalid-date rows with identical other fields collide (deterministic).
      const hash2 = generateDuplicateHash({
        symbol: "X",
        tradeDate: new Date("also-bad"),
        tradeType: "BUY",
        quantity: 10,
        price: 100,
      });
      assert.equal(hash, hash2);
    });
  });

  // ── sanitizeFormulaInjection ──

  describe("sanitizeFormulaInjection", () => {
    it("neutralizes = prefix", () => {
      const result = sanitizeFormulaInjection(
        "symbol,price\nRELIANCE,=100+200"
      );
      assert.ok(result.includes("'=100+200"));
    });

    it("neutralizes + prefix", () => {
      assert.ok(sanitizeFormulaInjection("a,b\n1,+cmd").includes("'+cmd"));
    });

    it("neutralizes - prefix", () => {
      assert.ok(sanitizeFormulaInjection("a,b\n1,-100").includes("'-100"));
    });

    it("neutralizes @ prefix", () => {
      assert.ok(
        sanitizeFormulaInjection("a,b\n1,@SUM(A1:A10)").includes(
          "'@SUM(A1:A10)"
        )
      );
    });

    it("neutralizes the classic =cmd|'/C calc'!A0 injection", () => {
      const evil = `symbol,note\nRELIANCE,=cmd|' /C calc'!A0`;
      const out = sanitizeFormulaInjection(evil);
      assert.ok(
        out.includes("'=cmd|"),
        "dangerous formula cell must be prefixed"
      );
    });

    it("neutralizes a leading whitespace-padded formula (trim then detect)", () => {
      // "  =cmd" — the sanitizer trims before testing the first char, so a
      // padded formula is still caught.
      const out = sanitizeFormulaInjection("a,b\n1,  =cmd");
      assert.ok(out.includes("'=cmd"));
    });

    it("leaves normal cells unchanged", () => {
      const result = sanitizeFormulaInjection("symbol,price\nRELIANCE,2500.50");
      assert.ok(result.includes("RELIANCE"));
      assert.ok(result.includes("2500.50"));
      // No stray neutralization quote should be introduced.
      assert.ok(!result.includes("'RELIANCE"));
      assert.ok(!result.includes("'2500.50"));
    });

    it("preserves a CRLF document's line structure", () => {
      const out = sanitizeFormulaInjection("a,b\r\n=evil,2");
      // The dangerous cell is neutralized and the \r is preserved in the line.
      assert.ok(out.includes("'=evil"));
      assert.ok(out.includes("\r"));
    });

    it("a QUOTED formula cell '\"=cmd\"' is neutralized (quote-aware sanitizer)", () => {
      // FIXED (MONEY-620): sanitizeFormulaInjection is now quote-aware — it
      // inspects the content *inside* a CSV-quoted cell, so `"=cmd|calc"` no
      // longer slips past the leading-double-quote and is re-emitted with the
      // neutralizing single quote inside the quotes (`"'=cmd|calc"`).
      // Belt-and-braces: parseCSVContent ALSO neutralizes at the parsed-cell
      // layer (after PapaParse unquoting), so the real persisted value is safe
      // regardless of quoting. Legitimate quoted values that merely contain a
      // comma are left untouched (their inner content is not a formula).
      const out = sanitizeFormulaInjection('symbol,note\nRELIANCE,"=cmd|calc"');
      assert.ok(
        out.includes("'\"=cmd") || out.includes("\"'=cmd"),
        "quoted formula should be neutralized"
      );
    });
  });

  // ── detectDelimiter ──

  describe("detectDelimiter", () => {
    it("detects comma delimiter", () => {
      assert.equal(detectDelimiter("a,b,c\n1,2,3\n4,5,6"), ",");
    });

    it("detects tab delimiter", () => {
      assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3\n4\t5\t6"), "\t");
    });

    it("detects semicolon delimiter", () => {
      assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
    });

    it("detects pipe delimiter", () => {
      assert.equal(detectDelimiter("a|b|c\n1|2|3\n4|5|6"), "|");
    });

    it("handles BOM", () => {
      assert.equal(detectDelimiter("﻿a,b,c\n1,2,3"), ",");
    });

    it("defaults to comma for empty content", () => {
      assert.equal(detectDelimiter(""), ",");
    });

    it("defaults to comma for single-column content (no delimiter present)", () => {
      // No line splits into >1 field on any delimiter ⇒ scores stay 0 ⇒ comma.
      assert.equal(detectDelimiter("symbol\nRELIANCE\nTCS"), ",");
    });

    it("ambiguous comma-vs-semicolon: comma wins (listed first, equal score)", () => {
      // Every line has one comma and one semicolon ⇒ both score 2*2=4; the loop
      // keeps the FIRST max (comma). Pin this tie-break so it can't silently flip.
      assert.equal(detectDelimiter("a,b;c\n1,2;3"), ",");
    });
  });

  // ── findHeaderRow ──

  describe("findHeaderRow", () => {
    it("finds header in first row", () => {
      const lines = [
        "Symbol,Trade Date,Quantity,Price,Exchange",
        "RELIANCE,2025-01-01,10,2500,NSE",
      ];
      assert.equal(findHeaderRow(lines, ","), 0);
    });

    it("finds header after metadata rows", () => {
      const lines = [
        "Zerodha Tradebook Export",
        "Date: 2025-01-01",
        "",
        "symbol,trade_date,quantity,price,exchange",
        "RELIANCE,2025-01-01,10,2500,NSE",
      ];
      assert.equal(findHeaderRow(lines, ","), 3);
    });

    it("defaults to 0 when no header is found (fewer than 3 known columns)", () => {
      assert.equal(
        findHeaderRow(["just some random data", "more random data"], ","),
        0
      );
    });

    it("requires at least 3 expected headers to match", () => {
      // Only 'symbol' + 'price' + 'exchange' = exactly 3 ⇒ matches at row 0.
      assert.equal(
        findHeaderRow(["symbol,price,exchange", "RELIANCE,2500,NSE"], ","),
        0
      );
      // Only 2 known headers ⇒ no match ⇒ fallback 0.
      assert.equal(findHeaderRow(["symbol,price", "RELIANCE,2500"], ","), 0);
    });
  });

  // ── normalizeColumnName ──

  describe("normalizeColumnName", () => {
    it("lowercases and trims", () => {
      assert.equal(normalizeColumnName("  Symbol  "), "symbol");
    });

    it("replaces non-alphanumeric with underscore", () => {
      assert.equal(normalizeColumnName("Trade Date"), "trade_date");
      assert.equal(normalizeColumnName("Buy/Sell"), "buy_sell");
    });

    it("preserves underscores", () => {
      assert.equal(normalizeColumnName("trade_type"), "trade_type");
    });
  });

  // ── getColumnMapping (8 broker formats) ──

  describe("getColumnMapping", () => {
    const ALL_FORMATS: BrokerFormat[] = [
      "zerodha",
      "upstox",
      "groww",
      "angel",
      "angelone",
      "dhan",
      "fyers",
      "generic",
    ];

    it("every broker format has the 5 required field arrays", () => {
      for (const format of ALL_FORMATS) {
        const m = getColumnMapping(format);
        for (const field of [
          "symbol",
          "tradeDate",
          "tradeType",
          "quantity",
          "price",
        ] as const) {
          assert.ok(
            Array.isArray(m[field]) && m[field].length > 0,
            `${format}.${field} must be a non-empty array`
          );
        }
      }
    });

    it("unknown format falls back to the generic mapping", () => {
      const unknown = getColumnMapping("does-not-exist" as BrokerFormat);
      assert.deepEqual(unknown, getColumnMapping("generic"));
    });

    it("zerodha exposes its snake_case header aliases", () => {
      const z = getColumnMapping("zerodha");
      assert.ok(z.tradeDate.includes("trade_date"));
      assert.ok(z.tradeType.includes("trade_type"));
    });
  });

  // ── parseCSVRow (per-row validation against the real source) ──

  describe("parseCSVRow", () => {
    const gen = getColumnMapping("generic");
    const okInput = {
      Symbol: "reliance",
      Date: "2025-01-01",
      Type: "B",
      Quantity: "10",
      Price: "2500.50",
      Exchange: "NSE",
    };

    it("parses a valid row, uppercasing symbol and normalizing BUY", () => {
      const r = parseCSVRow(okInput, gen, 1);
      assert.equal(r.error, undefined);
      assert.equal(r.data.symbol, "RELIANCE");
      assert.equal(r.data.tradeType, "BUY");
      assert.equal(r.data.quantity, 10);
      assert.equal(r.data.price, 2500.5);
      assert.equal(r.data.exchange, "NSE");
      assert.equal(r.data.segment, "EQUITY");
    });

    it("missing symbol → 'Missing symbol' error", () => {
      const { Symbol: _omit, ...rest } = okInput;
      void _omit;
      assert.equal(parseCSVRow(rest, gen, 1).error, "Missing symbol");
    });

    it("missing trade date → 'Missing trade date' error", () => {
      const { Date: _omit, ...rest } = okInput;
      void _omit;
      assert.equal(parseCSVRow(rest, gen, 1).error, "Missing trade date");
    });

    it("missing trade type → 'Missing trade type' error", () => {
      const { Type: _omit, ...rest } = okInput;
      void _omit;
      assert.equal(parseCSVRow(rest, gen, 1).error, "Missing trade type");
    });

    it("missing quantity → 'Missing quantity' error", () => {
      const { Quantity: _omit, ...rest } = okInput;
      void _omit;
      assert.equal(parseCSVRow(rest, gen, 1).error, "Missing quantity");
    });

    it("missing price → 'Missing price' error", () => {
      const { Price: _omit, ...rest } = okInput;
      void _omit;
      assert.equal(parseCSVRow(rest, gen, 1).error, "Missing price");
    });

    it("negative quantity is rejected (qty must be > 0)", () => {
      const r = parseCSVRow({ ...okInput, Quantity: "-10" }, gen, 1);
      assert.ok(r.error?.startsWith("Invalid quantity"), r.error);
    });

    it("zero quantity is rejected (qty must be > 0)", () => {
      const r = parseCSVRow({ ...okInput, Quantity: "0" }, gen, 1);
      assert.ok(r.error?.startsWith("Invalid quantity"), r.error);
    });

    it("non-numeric quantity is rejected (parseNumber→0 ⇒ ≤0 guard)", () => {
      const r = parseCSVRow({ ...okInput, Quantity: "abc" }, gen, 1);
      assert.ok(r.error?.startsWith("Invalid quantity"), r.error);
    });

    it("negative price is rejected (price must be ≥ 0)", () => {
      const r = parseCSVRow({ ...okInput, Price: "-100" }, gen, 1);
      assert.ok(r.error?.startsWith("Invalid price"), r.error);
    });

    it("zero price is allowed (price ≥ 0, e.g. bonus/free allotment)", () => {
      const r = parseCSVRow({ ...okInput, Price: "0" }, gen, 1);
      assert.equal(r.error, undefined);
      assert.equal(r.data.price, 0);
    });

    it("malformed / unparseable date is rejected with the offending value", () => {
      const r = parseCSVRow({ ...okInput, Date: "not-a-date" }, gen, 1);
      assert.equal(r.error, "Invalid date format: not-a-date");
    });

    it("Infinity quantity STRING is now rejected (parseNumber finiteness guard)", () => {
      // Regression for the parseNumber non-finite leak: an "Infinity" qty used
      // to slip past the `<= 0` check; the finiteness guard now sends it to 0
      // ⇒ 'Invalid quantity'. Pins the fix at the row layer.
      const r = parseCSVRow({ ...okInput, Quantity: "Infinity" }, gen, 1);
      assert.ok(r.error?.startsWith("Invalid quantity"), r.error);
    });

    it("a 12-char IN… symbol is detected as ISIN and copied into isin", () => {
      const r = parseCSVRow({ ...okInput, Symbol: "INE002A01018" }, gen, 1);
      assert.equal(r.error, undefined);
      assert.equal(r.data.isin, "INE002A01018");
    });

    it("a non-ISIN symbol leaves isin undefined", () => {
      const r = parseCSVRow(okInput, gen, 1);
      assert.equal(r.data.isin, undefined);
    });
  });

  // ── parseCSVContent (full-file: empty, BOM, unicode, header-not-found) ──

  describe("parseCSVContent", () => {
    it("empty file → no rows, no columns, no errors", () => {
      const r = parseCSVContent("");
      assert.deepEqual(r.rows, []);
      assert.deepEqual(r.columns, []);
      assert.deepEqual(r.errors, []);
    });

    it("whitespace-only file → no rows", () => {
      const r = parseCSVContent("   \n  \n");
      assert.deepEqual(r.rows, []);
    });

    it("strips a UTF-8 BOM from the first header so the symbol column resolves", () => {
      const r = parseCSVContent(
        "﻿symbol,trade_date,quantity,price\nRELIANCE,2025-01-01,10,100"
      );
      assert.deepEqual(r.columns, [
        "symbol",
        "trade_date",
        "quantity",
        "price",
      ]);
      assert.equal(r.rows.length, 1);
      // Without BOM stripping the key would be "﻿symbol" — assert it's clean.
      assert.equal((r.rows[0] as Record<string, unknown>).symbol, "RELIANCE");
      assert.ok(!Object.keys(r.rows[0] as object).some((k) => k.includes("﻿")));
    });

    it("preserves unicode content in non-ASCII symbol/name cells", () => {
      const r = parseCSVContent(
        "symbol,trade_date,quantity,price\nTÄTA,2025-01-01,5,100"
      );
      assert.equal(r.rows.length, 1);
      assert.equal((r.rows[0] as Record<string, unknown>).symbol, "TÄTA");
    });

    it("skips leading metadata rows and parses from the real header", () => {
      const csv = [
        "Tradebook Export",
        "Generated: 2025-01-01",
        "",
        "symbol,trade_date,quantity,price,exchange",
        "RELIANCE,2025-01-01,10,2500,NSE",
        "TCS,2025-01-02,5,3500,NSE",
      ].join("\n");
      const r = parseCSVContent(csv);
      assert.equal(r.rows.length, 2);
      assert.deepEqual(r.columns, [
        "symbol",
        "trade_date",
        "quantity",
        "price",
        "exchange",
      ]);
    });

    it("header-row-not-found: parses with the FIRST row as header (index 0 fallback)", () => {
      // No row matches ≥3 known headers ⇒ findHeaderRow returns 0 ⇒ PapaParse
      // treats line 0 as the header. The 'real' data row becomes a record keyed
      // by the junk header — no crash, no skipped rows.
      const csv = "foo,bar,baz\n1,2,3\n4,5,6";
      const r = parseCSVContent(csv);
      assert.deepEqual(r.columns, ["foo", "bar", "baz"]);
      assert.equal(r.rows.length, 2);
    });

    it("detects a semicolon-delimited European export end-to-end", () => {
      const csv =
        "symbol;trade_date;quantity;price\nRELIANCE;2025-01-01;10;100";
      const r = parseCSVContent(csv);
      assert.deepEqual(r.columns, [
        "symbol",
        "trade_date",
        "quantity",
        "price",
      ]);
      assert.equal(r.rows.length, 1);
      assert.equal((r.rows[0] as Record<string, unknown>).price, "100");
    });
  });

  // ── End-to-end: sanitize → parse → per-row (formula-injection rows) ──

  describe("formula-injection rows survive sanitize → parse → row pipeline", () => {
    it("a row whose symbol is a formula is neutralized then parsed as text", () => {
      const raw =
        "symbol,trade_date,trade_type,quantity,price\n=cmd,2025-01-01,BUY,10,100";
      const safe = sanitizeFormulaInjection(raw);
      const parsed = parseCSVContent(safe);
      assert.equal(parsed.rows.length, 1);
      // Symbol cell now starts with the neutralizing single-quote.
      assert.equal((parsed.rows[0] as Record<string, unknown>).symbol, "'=cmd");
      // And the row still parses (symbol "'=CMD" is non-empty, qty/price valid).
      const row = parseCSVRow(
        parsed.rows[0] as Record<string, unknown>,
        getColumnMapping("generic"),
        1
      );
      assert.equal(row.error, undefined);
      assert.equal(row.data.symbol, "'=CMD");
      assert.equal(row.data.tradeType, "BUY");
    });
  });
});
