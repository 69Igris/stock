/**
 * research-symbol-logic.ts — pure, side-effect-free helpers extracted from
 * `startResearchAction` (research.ts) so they can be unit-tested against the
 * REAL exported symbol (no shadow). The action imports and CALLS these, so the
 * production code path and the tests execute the same code.
 *
 * Importing `research.ts` directly into a test drags in Prisma / Pub/Sub /
 * services (it is a "use server" module), so this sibling holds only the pure
 * decision logic; the DB-backed symbol-resolution LOOP stays in the action but
 * is built from `cleanSymbol` + `formatInvalidSymbolError` exported here.
 *
 * Source of truth for: calling-convention detection, comparison auto-detection,
 * fund-shaped-query detection, symbol cleaning, invalid-symbol error text.
 */

/**
 * Old vs new calling convention for startResearchAction.
 *
 * Old callers pass `(userId, query, …)` where userId is a MongoDB ObjectId
 * (24 lowercase hex chars) or a Clerk id (prefixed `user_`). New callers pass
 * `(query, …)` and resolve the user from auth(). Returns true when the first
 * argument LOOKS LIKE a userId (old convention).
 */
export function looksLikeUserId(firstArg: string): boolean {
  return /^[a-f0-9]{24}$/.test(firstArg) || firstArg.startsWith("user_");
}

/** Result of comparison auto-detection: the (possibly upgraded) skill + mode. */
export interface ComparisonRouting {
  skill: string | undefined;
  mode: "fast" | "advanced" | undefined;
}

/**
 * Auto-detect a multi-symbol comparison run. When 2+ symbols are supplied
 * WITHOUT an explicit skill, route to `peer-comparison`; when 2+ symbols are
 * supplied WITHOUT an explicit mode, upgrade to `advanced`. An explicit skill
 * or mode is never overridden. 0/1 symbol is left untouched.
 */
export function autoDetectComparison(
  symbols: string[] | undefined,
  skill: string | undefined,
  mode: "fast" | "advanced" | undefined
): ComparisonRouting {
  let nextSkill = skill;
  let nextMode = mode;
  if (symbols && symbols.length > 1 && !nextSkill) {
    nextSkill = "peer-comparison";
  }
  if (symbols && symbols.length > 1 && !nextMode) {
    nextMode = "advanced";
  }
  return { skill: nextSkill, mode: nextMode };
}

/**
 * Fund-shaped queries (mutual funds prefixed `[MUTUAL_FUND]`, ETFs prefixed
 * `[ETF]`) bypass the equity-only InstrumentMapping symbol validation.
 */
export function isFundShapedQuery(query: string): boolean {
  return query.startsWith("[MUTUAL_FUND]") || query.startsWith("[ETF]");
}

/**
 * Normalize a user-entered symbol: uppercase + strip a trailing `.NS` / `.BO`
 * Yahoo-style exchange suffix. (`reliance.ns` → `RELIANCE`.)
 */
export function cleanSymbol(sym: string): string {
  return sym.toUpperCase().replace(/\.(NS|BO)$/, "");
}

/**
 * Strip a leading `@` the LLM classifier echoes back from the user's @mention.
 * Flash resolves a context symbol verbatim from the transcript, so a run can
 * arrive as `@140288` / `@RELIANCE`; the `@` is not part of the symbol and
 * would fail the InstrumentMapping lookup ("Symbol not found: @140288").
 */
export function stripMentionPrefix(sym: string): string {
  return sym.trim().replace(/^@+/, "");
}

/**
 * A LONE all-digit symbol is an AMFI mutual-fund scheme code (`140288`), never
 * an equity ticker — no NSE/BSE symbol is all-digits. Detecting it HERE (the
 * single funnel every caller reaches) rather than in a classifier is what makes
 * fund research work on EVERY path: the chat fast-path can set `assetType:"mf"`
 * explicitly, but a follow-up turn ("detailed deep-dive") loses the
 * `[Mentioned:]` context and is resolved from history by Flash with no such
 * hint. Safe by construction: an all-digit symbol would be REJECTED by the
 * equity validation anyway, so this only ever rescues an otherwise-dead run.
 */
export function isSchemeCodeRun(symbols: string[] | undefined): boolean {
  return (
    Array.isArray(symbols) && symbols.length === 1 && /^\d+$/.test(symbols[0]!)
  );
}

/**
 * User-facing error when one or more symbols cannot be resolved on NSE/BSE.
 * Singular vs plural is driven by the count.
 */
export function formatInvalidSymbolError(invalidSymbols: string[]): string {
  return `Symbol${invalidSymbols.length > 1 ? "s" : ""} not found on NSE/BSE: ${invalidSymbols.join(
    ", "
  )}. Please enter a valid Indian stock symbol (e.g., RELIANCE, TCS, INFY).`;
}
