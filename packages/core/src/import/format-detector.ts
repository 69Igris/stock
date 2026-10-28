/**
 * Header-based broker-format detection for trade CSV/XLSX imports.
 *
 * The import wizard's "Auto-detect" mode used to be a no-op — it just applied
 * the `generic` column mapping and the UI hardcoded the label "Auto-detect".
 * This module inspects the actual header row and returns the broker whose
 * *export* signature it matches, so auto-detect parses each broker's file with
 * the correct mapping and the UI can show the real detected broker (MONEY-1074).
 *
 * Detection is intentionally conservative: a format is only returned when at
 * least one STRONG, near-unique signature header is present. Weak-only or no
 * match falls back to `generic` (which is a broad superset mapping).
 */

import type { BrokerFormat } from "./types";

export interface DetectionResult {
  format: BrokerFormat;
  /** high = ≥2 strong tokens; medium = 1 strong token; low = generic fallback. */
  confidence: "high" | "medium" | "low";
}

interface BrokerSignature {
  format: BrokerFormat;
  /** Near-unique headers; presence strongly implies this broker's export. */
  strong: string[];
  /** Supporting headers; corroborate but never trigger detection alone. */
  weak: string[];
}

/**
 * Signatures are compared against normalized header tokens (lowercased, trimmed,
 * internal whitespace collapsed). Tokens must therefore be written pre-normalized.
 */
const SIGNATURES: BrokerSignature[] = [
  {
    format: "zerodha",
    // Zerodha & Upstox both carry trade_date/isin; `auction` +
    // `order_execution_time` are unique to the Zerodha Console tradebook.
    strong: ["order_execution_time", "auction"],
    weak: ["series", "trade_id", "order_id"],
  },
  {
    format: "dhan",
    strong: ["customsymbol", "securityid", "dhanclientid"],
    weak: ["exchangesegment", "drvoptiontype", "drvstrikeprice"],
  },
  {
    format: "fyers",
    strong: ["fyers order id", "exchange order id"],
    weak: ["traded price", "total value", "date and time"],
  },
  {
    format: "upstox",
    strong: ["scrip_name", "instrument_token"],
    weak: ["transaction_type", "amount"],
  },
  {
    format: "angel",
    strong: ["sauda", "trade no"],
    weak: ["order no", "buy/sell", "scrip"],
  },
  {
    format: "groww",
    strong: ["stock name"],
    weak: ["buy/sell"],
  },
];

/** Lowercase, trim, and collapse internal whitespace to a single space. */
export function normalizeHeaderToken(header: string): string {
  return (header ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Detect the broker format from a file's header row. Returns `generic` (low
 * confidence) when no strong signature matches — callers should then parse with
 * the generic superset mapping.
 */
export function detectBrokerFormat(headers: string[]): DetectionResult {
  const normalized = headers.map(normalizeHeaderToken).filter(Boolean);
  const present = new Set(normalized);
  const has = (token: string) => present.has(token);

  let best: { format: BrokerFormat; strong: number; weak: number } | null =
    null;

  for (const sig of SIGNATURES) {
    const strong = sig.strong.filter(has).length;
    if (strong === 0) continue; // only trust a match with a strong token
    const weak = sig.weak.filter(has).length;
    if (
      !best ||
      strong > best.strong ||
      (strong === best.strong && weak > best.weak)
    ) {
      best = { format: sig.format, strong, weak };
    }
  }

  if (!best) return { format: "generic", confidence: "low" };
  return {
    format: best.format,
    confidence: best.strong >= 2 ? "high" : "medium",
  };
}

/**
 * Resolve the broker format to actually PARSE with (MONEY-1074). In auto-detect
 * mode (`generic`) inspect the header row and switch to the detected broker's
 * mapping (falling back to `generic` when nothing matches); an explicit broker
 * choice is respected as-is. Single source of truth shared by the web preview
 * action and the worker so the two never diverge.
 */
export function resolveEffectiveBrokerFormat(
  requestedFormat: BrokerFormat,
  headers: string[],
): BrokerFormat {
  if (requestedFormat === "generic" || !requestedFormat) {
    return detectBrokerFormat(headers).format;
  }
  return requestedFormat;
}

/** Human-readable label for a detected/selected broker format. */
export function brokerFormatLabel(format: BrokerFormat): string {
  switch (format) {
    case "zerodha":
      return "Zerodha";
    case "upstox":
      return "Upstox";
    case "groww":
      return "Groww";
    case "angel":
    case "angelone":
      return "Angel One";
    case "dhan":
      return "Dhan";
    case "fyers":
      return "Fyers";
    case "generic":
    default:
      return "Standard format";
  }
}
