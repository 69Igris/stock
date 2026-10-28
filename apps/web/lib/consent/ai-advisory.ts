/**
 * AI-advisory disclosure copy + version — MONEY-505 / 501 (SEBI IA Reg 18(9)).
 *
 * Single source of truth for the AI-advisory disclosure text and its version,
 * shown before advisory output (the broker-connect consent modal + the chat
 * entry micro-disclosure) and recorded in the ConsentRecord ledger
 * (kind AI_ADVISORY). Bump AI_ADVISORY_VERSION whenever the wording materially
 * changes so the ledger records exactly which disclosure each user accepted.
 *
 * This is distinct from the MONEY-566 exchange-delayed-data note
 * (components/market/DelayedDataNote.tsx): that is about market-data delay; this
 * is about AI advice not being SEBI-registered advice.
 */

/** Bump on any material wording change (records into ConsentRecord.version). */
export const AI_ADVISORY_VERSION = "2026-05-30";

export const AI_ADVISORY_DISCLOSURE = {
  heading: "About StockSage AI",
  /** One-line micro-disclosure (chat entry, message footers). */
  short:
    "StockSage is AI — informational analysis only, not advice from a SEBI-registered Investment Adviser. It never places trades.",
  /** Full bullets shown in the consent modal. */
  points: [
    "StockSage is an AI assistant (powered by Google Gemini) that summarises and analyses market data and your portfolio.",
    "It is NOT a SEBI-registered Investment Adviser and does not provide personalised investment advice — nothing it says is a recommendation to buy, sell, or hold any security.",
    "It can be wrong or incomplete. Verify every number against the source before acting, and consult a SEBI-registered Investment Adviser for advice.",
    "It is read-only: it analyses your connected data and never places, modifies, or cancels any trade or order.",
    "Market data shown without an active broker connection is exchange-delayed (~15 min).",
  ],
  ackLabel: "I understand StockSage is informational AI, not investment advice",
} as const;
