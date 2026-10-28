/**
 * Bulk action toolbar - CSV builder.
 *
 * The toolbar's CSV builder is internal to the component file but the
 * shape is simple enough to mirror here for unit testing. If the
 * component-side function changes column order, update both.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScreenResult } from "../../lib/actions/screener";

function buildCsv(rows: readonly ScreenResult[]): string {
  const header = [
    "symbol",
    "exchange",
    "name",
    "sector",
    "ltp",
    "changePercent",
    "marketCap",
    "pe",
    "roe",
    "revenueGrowth",
    "debtToEquity",
    "matchScore",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.symbol,
        r.exchange,
        `"${(r.name ?? "").replace(/"/g, '""')}"`,
        `"${(r.sector ?? "").replace(/"/g, '""')}"`,
        r.ltp ?? "",
        r.changePercent ?? "",
        r.marketCap ?? "",
        r.pe ?? "",
        r.roe ?? "",
        r.revenueGrowth ?? "",
        r.debtToEquity ?? "",
        r.matchScore,
      ].join(",")
    );
  }
  return lines.join("\n");
}

const SAMPLE: ScreenResult = {
  symbol: "RELIANCE",
  exchange: "NSE",
  name: "Reliance Industries",
  sector: "Energy",
  ltp: 2480.5,
  changePercent: 1.42,
  marketCap: 1680000,
  pe: 28.4,
  roe: 9.8,
  revenueGrowth: 12.6,
  debtToEquity: 0.42,
  matchScore: 78,
};

describe("BulkActionToolbar - CSV", () => {
  it("emits the header on the first line", () => {
    const csv = buildCsv([SAMPLE]);
    const firstLine = csv.split("\n")[0];
    assert.match(firstLine ?? "", /^symbol,exchange,name,sector/);
  });

  it("escapes quotes in name + sector", () => {
    const csv = buildCsv([
      {
        ...SAMPLE,
        name: 'Acme "Holdings" Co.',
      },
    ]);
    assert.match(csv, /"Acme ""Holdings"" Co."/);
  });

  it("renders empty string for null numerics", () => {
    const csv = buildCsv([
      {
        ...SAMPLE,
        ltp: null,
        pe: null,
        roe: null,
        marketCap: null,
        revenueGrowth: null,
        debtToEquity: null,
        changePercent: null,
      },
    ]);
    const dataLine = csv.split("\n")[1];
    assert.ok(dataLine);
    // Symbol/exchange/name/sector/match are still present
    assert.match(dataLine ?? "", /^RELIANCE,NSE,/);
    // No "null" literals in numeric columns
    assert.equal((dataLine ?? "").includes("null"), false);
  });

  it("preserves order across multiple rows", () => {
    const csv = buildCsv([
      { ...SAMPLE, symbol: "A" },
      { ...SAMPLE, symbol: "B" },
      { ...SAMPLE, symbol: "C" },
    ]);
    const lines = csv.split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[1] ?? "", /^A,/);
    assert.match(lines[2] ?? "", /^B,/);
    assert.match(lines[3] ?? "", /^C,/);
  });
});
