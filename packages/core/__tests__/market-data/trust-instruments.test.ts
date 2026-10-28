/**
 * UNIT TEST — REIT / InvIT classification and fund-surface wiring.
 *
 * MONEY-1085 follow-up. Zerodha types every cash-segment instrument `EQ`, so
 * REITs and InvITs landed as `EQUITY` and were compared against operating
 * companies on P/E and earnings growth — metrics that mean something different
 * for a trust that distributes nearly all its cash flow.
 *
 * The reclassification has a sharp edge worth testing loudly: moving them OUT
 * of `EQUITY` means any surface still filtering on `instrumentType: "ETF"`
 * alone drops them from BOTH lists — off stocks (no longer EQUITY) and off
 * funds (not ETF). `FUND_INSTRUMENT_TYPES` exists to make that unreachable, and
 * the scan at the bottom pins every query site to it.
 *
 * Names below are verbatim from the live Zerodha dump (2026-07-28).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  classifyTrustInstrument,
  isETF,
  mapCSVRowToRaw,
  NSE_TRUST_SERIES,
} from "../../src/market-data/instruments/zerodha-instruments-logic";
import {
  FUND_INSTRUMENT_TYPES,
  TRUST_INSTRUMENT_TYPES,
} from "../../src/market-data/instruments/types";

describe("classifyTrustInstrument", () => {
  test("recognises every REIT in the live dump", () => {
    const reits: Array<[string, string]> = [
      ["EMBASSY", "EMBASSY OFFICE PARKS REIT"],
      ["MINDSPACE", "MINDSPACE BUSINESS PARKS REIT"],
      ["BIRET", "BROOKFIELD INDIA REIT"],
      ["NXST", "NEXUS SELECT TRUST REIT"],
      ["KRT", "KNOWLEDGE REALTY TRUST REIT"],
      ["BAGMANE", "BAGMANE PRIME OFFICE REIT"],
    ];
    for (const [sym, name] of reits) {
      assert.equal(
        classifyTrustInstrument(sym, name),
        "REIT",
        `${sym}: ${name}`,
      );
    }
  });

  test("recognises every InvIT in the live dump", () => {
    const invits: Array<[string, string]> = [
      ["IRBINVIT", "IRB INVIT FUND"],
      ["INDIGRID", "INDIGRID INFRA TRUST (INVIT)"],
      ["PGINVIT", "POWERGRID INFRA INVIT"],
      ["NHIT", "NATIONAL HIGHWAYS INVIT"],
      ["INDUSINVIT", "INDUS INFRA TRUST (INVIT)"],
      ["CAPINVIT", "CAPITAL INFRA TRUST (INVIT)"],
      ["ANANTAM", "ANANTAM HIGHWAYS TRUST (INVIT)"],
      ["SHREMINVIT-IV", "SHREM INVIT"],
    ];
    for (const [sym, name] of invits) {
      assert.equal(
        classifyTrustInstrument(sym, name),
        "INVIT",
        `${sym}: ${name}`,
      );
    }
  });

  test("accepts the long-form registered names", () => {
    assert.equal(
      classifyTrustInstrument("X", "SOME REAL ESTATE INVESTMENT TRUST"),
      "REIT",
    );
    assert.equal(
      classifyTrustInstrument("Y", "SOME INFRASTRUCTURE INVESTMENT TRUST"),
      "INVIT",
    );
  });

  test("leaves ordinary companies alone", () => {
    for (const name of [
      "RELIANCE INDUSTRIES",
      "TATA CONSULTANCY SERVICES",
      "DLF LIMITED", // real estate DEVELOPER — an operating company, not a REIT
      "IRB INFRASTRUCTURE DEVELOPERS", // operating company; the InvIT is IRBINVIT
    ]) {
      assert.equal(classifyTrustInstrument("X", name), null, name);
    }
  });

  test("word-boundary matched — a substring can't misclassify", () => {
    // The failure this prevents: a naive includes("REIT") would swallow these.
    assert.equal(classifyTrustInstrument("X", "REITERATED HOLDINGS"), null);
    assert.equal(classifyTrustInstrument("X", "STREITWISE LABS"), null);
  });

  test("tolerates missing/blank names rather than throwing", () => {
    assert.equal(classifyTrustInstrument("X", ""), null);
    assert.equal(
      classifyTrustInstrument("X", undefined as unknown as string),
      null,
    );
  });

  test("InvIT wins when a name mentions both (an InvIT is never a REIT)", () => {
    assert.equal(
      classifyTrustInstrument("X", "SOMETHING REIT INVIT TRUST"),
      "INVIT",
    );
  });
});

describe("mapCSVRowToRaw — trust rows come out typed", () => {
  const row = (tradingsymbol: string, name: string) => ({
    instrument_token: "1",
    exchange_token: "1",
    tradingsymbol,
    name,
    last_price: "0",
    expiry: "",
    strike: "0",
    tick_size: "0.05",
    lot_size: "1",
    instrument_type: "EQ",
    segment: "NSE",
    exchange: "NSE",
  });

  test("a REIT becomes instrumentType REIT, not EQUITY", () => {
    assert.equal(
      mapCSVRowToRaw(row("EMBASSY", "EMBASSY OFFICE PARKS REIT"))
        .instrumentType,
      "REIT",
    );
  });

  test("an InvIT becomes instrumentType INVIT", () => {
    assert.equal(
      mapCSVRowToRaw(row("IRBINVIT", "IRB INVIT FUND")).instrumentType,
      "INVIT",
    );
  });

  test("an ordinary equity is untouched", () => {
    assert.equal(
      mapCSVRowToRaw(row("RELIANCE", "RELIANCE INDUSTRIES")).instrumentType,
      "EQUITY",
    );
  });

  test("ETF classification still wins over the trust check", () => {
    // Ordering guard: a fund-of-trusts must stay an ETF, since the ETF
    // machinery (expense enrichment, AMC derivation) keys off that type.
    const mapped = mapCSVRowToRaw(row("REALTYETF", "SOME REALTY REIT ETF"));
    assert.ok(isETF("REALTYETF", "SOME REALTY REIT ETF"));
    assert.equal(mapped.instrumentType, "ETF");
  });
});

describe("NSE_TRUST_SERIES", () => {
  test("maps the NSE cash series NSE assigns to trusts", () => {
    assert.equal(NSE_TRUST_SERIES.RR, "REIT");
    assert.equal(NSE_TRUST_SERIES.IV, "INVIT");
  });

  test("every trust series maps to a declared trust type", () => {
    for (const t of Object.values(NSE_TRUST_SERIES)) {
      assert.ok(
        (TRUST_INSTRUMENT_TYPES as readonly string[]).includes(t),
        `${t} must be in TRUST_INSTRUMENT_TYPES`,
      );
    }
  });
});

describe("fund surfaces include the trusts (MONEY-1085 follow-up)", () => {
  test("FUND_INSTRUMENT_TYPES covers ETF plus every trust type", () => {
    assert.deepEqual([...FUND_INSTRUMENT_TYPES], ["ETF", "REIT", "INVIT"]);
    for (const t of TRUST_INSTRUMENT_TYPES) {
      assert.ok(
        (FUND_INSTRUMENT_TYPES as readonly string[]).includes(t),
        `${t} is a trust but not on the funds surface — it would be invisible ` +
          `in discovery (not EQUITY either)`,
      );
    }
  });

  test('no fund query hard-codes instrumentType: "ETF"', () => {
    // THE GUARD. A surface filtering on "ETF" alone drops REIT/INVIT from both
    // the stocks list and the funds list. Adding a new fund-ish type must be a
    // one-line change to FUND_INSTRUMENT_TYPES, not a hunt through services.
    const roots = [
      join("..", "services", "src"),
      join("..", "..", "apps", "web", "lib"),
    ];
    const SKIP = new Set(["node_modules", "dist", ".next", "__tests__"]);
    const offenders: string[] = [];

    function* walk(dir: string): Generator<string> {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP.has(e)) continue;
        const full = join(dir, e);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) yield* walk(full);
        else if (/\.tsx?$/.test(e)) yield full;
      }
    }

    // Only the DB-query shape matters: `instrumentType: "ETF"` as a filter.
    // Comparisons and display strings elsewhere are fine.
    // Not followed by `|` — that shape is a TYPE annotation
    // (`instrumentType: "ETF" | "INDEX"`) describing a return value, not a
    // Prisma filter, and is legitimate.
    const HARDCODED = /instrumentType:\s*"ETF"(?!\s*\|)/;
    for (const root of roots) {
      for (const file of walk(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (HARDCODED.test(line))
              offenders.push(`${file}:${i + 1} ${line.trim()}`);
          });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "use `instrumentType: { in: [...FUND_INSTRUMENT_TYPES] }` — a bare " +
        '"ETF" filter silently drops REITs and InvITs from the funds surface:\n' +
        offenders.join("\n"),
    );
  });
});
