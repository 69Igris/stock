/**
 * DodoPayments wallet ledger CSV parser.
 *
 * DodoPayments does NOT expose a stable transaction-history API (per their
 * docs as of 2026-04). The contract is: the admin downloads the wallet ledger
 * CSV from Dodo's dashboard and uploads it to UseMoney. This module parses
 * those rows into a normalised shape that the staging table can consume.
 *
 * Header schema as of 2026-04 - if Dodo changes their CSV columns, parsing
 * fails fast with a clear error rather than silently misinterpreting.
 *
 * Expected headers (in any order, case-insensitive):
 *   transaction_id        (required)
 *   payout_id             (optional)
 *   transaction_date      (required, ISO-8601 or YYYY-MM-DD)
 *   customer_email        (optional)
 *   customer_country      (optional, ISO-2)
 *   currency              (required, ISO-4217)
 *   gross_amount          (required, numeric)
 *   fees_amount           (required, numeric)
 *   net_amount            (required, numeric)
 */

import { createHash } from "node:crypto";

export interface ParsedDodoRow {
  transactionId: string;
  payoutId?: string;
  customerEmail?: string;
  customerCountry?: string;
  currency: string;
  grossAmount: number;
  feesAmount: number;
  netAmount: number;
  transactionDate: Date;
  rawRow: Record<string, string>;
}

export interface ParseResult {
  rows: ParsedDodoRow[];
  csvHash: string;
  headerErrors: string[];
  rowErrors: Array<{ rowIndex: number; reason: string }>;
}

const REQUIRED_HEADERS = [
  "transaction_id",
  "transaction_date",
  "currency",
  "gross_amount",
  "fees_amount",
  "net_amount",
] as const;

const OPTIONAL_HEADERS = [
  "payout_id",
  "customer_email",
  "customer_country",
] as const;

const ALL_HEADERS = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS];

/**
 * RFC-4180-ish CSV line splitter that handles quoted commas and embedded
 * double-quotes. Not a full RFC implementation - Dodo exports do not embed
 * newlines inside fields, so the line-by-line outer loop is sufficient.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"' && cur === "") {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseAmount(raw: string | undefined): number | null {
  if (raw == null) return null;
  // Strip thousands separators (",") and currency symbols, allow "(123.45)" for negative.
  const cleaned = raw.replace(/[,\s$£€₹]/g, "").trim();
  if (cleaned === "") return null;
  const isParenNegative = /^\(.*\)$/.test(cleaned);
  const num = Number.parseFloat(
    isParenNegative ? cleaned.slice(1, -1) : cleaned,
  );
  if (!Number.isFinite(num)) return null;
  return isParenNegative ? -num : num;
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Accept ISO-8601 ("2026-04-15T..."), plain date ("2026-04-15"), or "DD/MM/YYYY".
  const isoMatch = /^\d{4}-\d{2}-\d{2}/.test(trimmed);
  if (isoMatch) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ddmm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (ddmm) {
    const [, day, month, year] = ddmm;
    const d = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0),
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Compute a stable SHA-256 hash of the CSV content for idempotency. Hashing
 * the sorted set of transaction IDs (rather than the raw bytes) lets us detect
 * a re-upload even if the user re-exported with different row ordering or
 * extra blank lines. Re-uploads with NEW rows produce a different hash, which
 * is the desired behaviour - partial overlap is handled by the upsert layer
 * looking at `transactionId` uniqueness.
 */
function computeCsvHash(rows: ParsedDodoRow[]): string {
  const sortedIds = rows
    .map((r) => r.transactionId)
    .sort()
    .join("\n");
  return createHash("sha256").update(sortedIds).digest("hex");
}

export function parseDodoCsv(csvText: string): ParseResult {
  const headerErrors: string[] = [];
  const rowErrors: Array<{ rowIndex: number; reason: string }> = [];
  const rows: ParsedDodoRow[] = [];

  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/, "")) // strip BOM
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    headerErrors.push("CSV is empty");
    return { rows, csvHash: "", headerErrors, rowErrors };
  }

  const headerCells = splitCsvLine(lines[0]!).map((h) =>
    h.toLowerCase().trim(),
  );

  // Verify required headers
  for (const required of REQUIRED_HEADERS) {
    if (!headerCells.includes(required)) {
      headerErrors.push(`Missing required column: ${required}`);
    }
  }
  if (headerErrors.length > 0) {
    return { rows, csvHash: "", headerErrors, rowErrors };
  }

  const headerIndex: Record<string, number> = {};
  for (const name of ALL_HEADERS) {
    const idx = headerCells.indexOf(name);
    if (idx >= 0) headerIndex[name] = idx;
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const get = (key: string) =>
      headerIndex[key] !== undefined ? cells[headerIndex[key]!] : undefined;

    const rawRow: Record<string, string> = {};
    for (const [name, idx] of Object.entries(headerIndex)) {
      rawRow[name] = (cells[idx] ?? "").trim();
    }

    const transactionId = (get("transaction_id") || "").trim();
    if (!transactionId) {
      rowErrors.push({ rowIndex: i, reason: "missing transaction_id" });
      continue;
    }

    const transactionDate = parseDate(get("transaction_date"));
    if (!transactionDate) {
      rowErrors.push({ rowIndex: i, reason: "invalid transaction_date" });
      continue;
    }

    const currency = (get("currency") || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      rowErrors.push({ rowIndex: i, reason: `invalid currency: ${currency}` });
      continue;
    }

    const grossAmount = parseAmount(get("gross_amount"));
    const feesAmount = parseAmount(get("fees_amount"));
    const netAmount = parseAmount(get("net_amount"));
    if (grossAmount === null || feesAmount === null || netAmount === null) {
      rowErrors.push({ rowIndex: i, reason: "invalid amount field" });
      continue;
    }

    rows.push({
      transactionId,
      payoutId: get("payout_id")?.trim() || undefined,
      customerEmail: get("customer_email")?.trim() || undefined,
      customerCountry:
        get("customer_country")?.trim().toUpperCase() || undefined,
      currency,
      grossAmount,
      feesAmount,
      netAmount,
      transactionDate,
      rawRow,
    });
  }

  return {
    rows,
    csvHash: computeCsvHash(rows),
    headerErrors,
    rowErrors,
  };
}
