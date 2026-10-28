/**
 * Shared NSE filing types — kept network-free so `nse-filings-logic.ts` (and
 * its tests) can import them without pulling `ky` / the live fetchers.
 */

export interface NSEFiling {
  symbol: string;
  title: string;
  description: string;
  attachmentUrl: string | null;
  filingDate: Date;
  category: string; // "Annual Report", "Financial Results", "Board Meeting", etc.
}

/**
 * Normalized corporate-action type. Mirrors the `type` column on the
 * `CorporateAction` Prisma model (MONEY-840/844). `OTHER` is the fall-back when
 * the free-text subject doesn't match a known class — the raw subject is kept in
 * `details` so nothing is lost.
 */
export type CorporateActionType =
  | "SPLIT"
  | "BONUS"
  | "BUYBACK"
  | "DEMERGER"
  | "MERGER"
  | "DIVIDEND"
  | "RIGHTS"
  | "AGM"
  | "OTHER";

export interface NSECorporateAction {
  symbol: string;
  /**
   * The raw, upper-cased free-text subject (e.g. "FACE VALUE SPLIT FROM RS 10
   * TO RS 1"). Kept for backwards-compat + debugging. Use `type` for the
   * normalized class.
   */
  actionType: string;
  /**
   * Normalized class extracted from the free-text subject. This is what feeds
   * the `CorporateAction.type` column; `actionType` keeps the verbatim subject.
   */
  type: CorporateActionType;
  exDate: Date | null;
  recordDate: Date | null;
  /**
   * Post:pre share ratio for quantity-changing actions (split 1:5 → 5, bonus
   * 1:1 → 2, face-value split Rs 10 → Rs 1 → 10). `null` for actions that don't
   * change the share count (e.g. DIVIDEND).
   */
  ratio: number | null;
  /** Face value BEFORE a split (e.g. 10 for "Rs 10 to Rs 1"). */
  oldFaceValue: number | null;
  /** Face value AFTER a split (e.g. 1 for "Rs 10 to Rs 1"). */
  newFaceValue: number | null;
  /** Per-share cash dividend (DIVIDEND only); informational, not cost-basis. */
  dividendPerShare: number | null;
  /** Raw free-text subject preserved verbatim. */
  details: string;
  rawData: Record<string, unknown>;
}
