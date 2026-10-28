/**
 * Databento error taxonomy — MONEY-1373.
 *
 * A LEAF module: it imports nothing from this folder, which is what lets the
 * client, the budget guard and the jobs all depend on it without a cycle. The
 * same arrangement `tiingo-errors.ts` documents, and for the same reason —
 * there, the pacer needed to subclass the client's error and would have made
 * the two import each other.
 */

/** The API key is absent, rejected, or the plan does not cover the endpoint. */
export class DatabentoAuthError extends Error {
  constructor(
    message: string,
    /** The HTTP status behind the refusal, or 0 when the key was never sent. */
    readonly status: number = 0,
  ) {
    super(message);
    this.name = "DatabentoAuthError";
  }
}

/**
 * A 429.
 *
 * Carries the wait the vendor asked for. Databento documents `Retry-After` and
 * its own client honours it with a ONE-SECOND default when the header is
 * absent; the limits are PER IP, and Cloud Run shares egress addresses, so the
 * cost of ignoring this is borne by every environment we own.
 */
export class DatabentoRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterS: number,
  ) {
    super(message);
    this.name = "DatabentoRateLimitError";
  }
}

/**
 * A downloaded file's sha256 did not match the manifest.
 *
 * This is a THROW, not a warning, and that is a deliberate divergence from the
 * vendor's own client, which logs a warning and keeps the file. These bytes are
 * the only copy of data bought once inside a one-month subscription window; a
 * truncated file that nothing rejects becomes a coverage gap that gets read as
 * the vendor short-changing us, months later, with the subscription cancelled.
 */
export class DatabentoChecksumError extends Error {
  constructor(
    readonly filename: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Databento file ${filename} failed checksum: expected sha256 ${expected}, ` +
        `computed ${actual}. The partial object was deleted from the archive.`,
    );
    this.name = "DatabentoChecksumError";
  }
}

/** The request was refused on its own terms (bad params, unknown dataset). */
export class DatabentoRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DatabentoRequestError";
  }
}
