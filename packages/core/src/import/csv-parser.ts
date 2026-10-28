/**
 * CSV file parsing with PapaParse.
 * Includes automatic delimiter detection and header row scanning.
 */

import Papa from "papaparse";
import type { ParsedFileData } from "./types";
import { neutralizeFormulaCell } from "./sanitize";

/**
 * Detect the most likely delimiter in CSV content.
 * Tests comma, semicolon, tab, and pipe against the first 30 non-empty lines.
 * Scores by consistency (frequency of most common field count) * field count.
 */
export function detectDelimiter(content: string): string {
  // Strip BOM if present
  const cleanContent = content.replace(/^\uFEFF/, "");

  const nonEmptyLines = cleanContent
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 30);
  if (nonEmptyLines.length === 0) return ",";

  const delimiters = [",", ";", "\t", "|"];
  let bestDelimiter = ",";
  let bestScore = 0;

  for (const delimiter of delimiters) {
    const fieldCounts = nonEmptyLines.map(
      (line) => line.split(delimiter).length,
    );

    const countFreq: Record<number, number> = {};
    for (const count of fieldCounts) {
      if (count > 1) {
        countFreq[count] = (countFreq[count] || 0) + 1;
      }
    }

    let maxFreq = 0;
    let fieldCount = 0;
    for (const [count, freq] of Object.entries(countFreq)) {
      if (freq > maxFreq || (freq === maxFreq && Number(count) > fieldCount)) {
        maxFreq = freq;
        fieldCount = Number(count);
      }
    }

    const score = maxFreq * fieldCount;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }

  return bestDelimiter;
}

/**
 * Find the header row index in CSV lines.
 * Scans the first 30 lines looking for rows that contain at least 3
 * expected trade-related column names. Returns 0 if no header row is found.
 */
export function findHeaderRow(lines: string[], delimiter: string): number {
  // Superset of trade-header tokens across all supported broker exports, so a
  // preamble block (client name / period rows) above the real header is skipped
  // for Fyers ("Name"/"Qty"/"Side"), Dhan ("customSymbol"), Angel ("Scrip"/
  // "Buy/Sell"), and mutual-fund exports ("Scheme Name"/"NAV"/"Units"), not just
  // the generic symbol/price/quantity trio. The ≥3-match threshold keeps a
  // stray preamble line (which rarely carries 3 distinct trade headers) from
  // being mistaken for the header row.
  const expectedHeaders = [
    "symbol",
    "trade date",
    "trade_date",
    "date and time",
    "quantity",
    "qty",
    "price",
    "traded price",
    "nav",
    "units",
    "trade type",
    "trade_type",
    "side",
    "buy/sell",
    "isin",
    "exchange",
    "segment",
    "scrip",
    "name",
    "customsymbol",
  ];

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i];
    if (!line?.trim()) continue;

    const fields = line
      .toLowerCase()
      .split(delimiter)
      .map((f) => f.trim().replace(/"/g, ""));
    const matchCount = expectedHeaders.filter((h) =>
      fields.some((f) => f.includes(h)),
    ).length;

    if (matchCount >= 3) return i;
  }

  return 0;
}

/**
 * Parse CSV content into structured row data using PapaParse.
 * Handles BOM stripping, delimiter detection, header row scanning,
 * and metadata row skipping.
 */
export function parseCSVContent(content: string): ParsedFileData {
  // Strip BOM if present
  const cleanContent = content.replace(/^\uFEFF/, "");

  const delimiter = detectDelimiter(cleanContent);
  const lines = cleanContent.split(/\r?\n/);
  const headerRowIndex = findHeaderRow(lines, delimiter);

  // Skip metadata rows if header is not the first row
  const contentToParse =
    headerRowIndex > 0 ? lines.slice(headerRowIndex).join("\n") : cleanContent;

  const parseResult = Papa.parse<Record<string, unknown>>(contentToParse, {
    header: true,
    skipEmptyLines: true,
    delimiter: delimiter,
    transformHeader: (header) => header.trim().replace(/"/g, ""),
  });

  // Filter out non-critical warnings (like delimiter detection messages)
  const criticalErrors = parseResult.errors.filter(
    (e) =>
      e.row !== undefined &&
      !e.message?.includes("Unable to auto-detect") &&
      !e.message?.includes("defaulted to"),
  );

  // Neutralize formula injection at the PARSED-cell layer. PapaParse has now
  // unquoted each field, so a CSV-quoted formula like "=cmd|calc" (which slips
  // past the raw pre-parse text sanitizer because of its leading quote) is
  // caught here on its real value before it is persisted or displayed.
  // Non-string and non-formula values are left untouched.
  const sanitizedRows = parseResult.data.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      const value = row[key];
      out[key] =
        typeof value === "string" ? neutralizeFormulaCell(value) : value;
    }
    return out;
  });

  return {
    rows: sanitizedRows,
    columns: parseResult.meta.fields || [],
    errors:
      criticalErrors.length > 0
        ? criticalErrors.slice(0, 5).map((e) => `Row ${e.row}: ${e.message}`)
        : [],
  };
}
