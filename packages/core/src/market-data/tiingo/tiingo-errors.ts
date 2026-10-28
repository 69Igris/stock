/**
 * Tiingo error taxonomy — MONEY-1263.
 *
 * A LEAF module: it imports nothing from this folder, which is what lets both
 * `tiingo-client.ts` and `tiingo-pacer.ts` depend on it. These classes used to
 * live in the client, and when the pacer needed to subclass `TiingoRateLimitError`
 * that would have made the client and the pacer import each other — a cycle,
 * and the TDZ hazard the market-data barrel already documents.
 *
 * `tiingo-client.ts` re-exports both, so every existing import path keeps
 * working and no consumer had to be found and edited.
 */

/**
 * Raised when Tiingo signals we are over quota.
 *
 * Callers circuit-break the whole RUN on this rather than retrying the next
 * symbol, per the Screener/BSE precedent: a run that has hit the wall spends
 * its remaining budget collecting the same error.
 */
export class TiingoRateLimitError extends Error {
  constructor(context: string) {
    super(`Tiingo rate-limited for ${context} after retries`);
    this.name = "TiingoRateLimitError";
  }
}

/**
 * Raised when Tiingo refuses the request: the token is rejected, or the plan
 * does not cover the endpoint. We CANNOT tell which — see
 * {@link classifyTiingoError}.
 */
export class TiingoAuthError extends Error {
  /**
   * A token problem cannot be ruled out. Always true for a 401/403.
   *
   * MONEY-980 review, finding 3: this used to be a claim of FACT, decided from
   * a response body the caller never had — `classifyTiingoError(status, "")`,
   * an empty string at every call site. So EVERY 403 took the "empty body means
   * entitlement" branch, and a wrong `TIINGO_API_KEY_PROD` reached the operator
   * as "the plan does not cover this endpoint … this is NOT a token problem",
   * pointing away from the only one of the two causes that changes between
   * deploys.
   *
   * Kept rather than deleted because two consumers already read it
   * (`workers/src/processors/us-eod-sync.ts` and
   * `scripts/jobs/tiingo-us-backfill.ts`), and set to `true` because the token
   * is the CHEAP, SELF-FALSIFYING check: re-running the URL by hand answers it
   * in seconds, and a plan entitlement is a static property of the account that
   * does not spontaneously change. It is a triage ordering, NOT a verdict —
   * `message` names both causes and both checks so no reader is left holding
   * only this flag.
   *
   * Typed `boolean` deliberately: a literal `true` would let a consumer's
   * `else` branch be narrowed away, and the branch is only dead until the
   * body becomes readable again.
   */
  readonly isTokenProblem: boolean = true;

  constructor(
    message: string,
    /**
     * The HTTP status behind the refusal, or 0 when the seam's thrown message
     * carried none. The only discriminating fact that survives the archive
     * seam, so it is carried rather than re-parsed downstream.
     */
    readonly status: number,
  ) {
    super(message);
    this.name = "TiingoAuthError";
  }
}
