/**
 * Document processing failure classification — MONEY-1168 (pure).
 *
 * ## The defect
 *
 * A URL import that failed showed the user a bare **FAILED**, size `-`, and
 * nothing else. Three very different situations were indistinguishable: the
 * remote host refused us, the URL was wrong, or our own pipeline broke.
 *
 * That ambiguity is not cosmetic — it masked a real investigation. The URL from
 * the original report:
 *
 *   https://www.tcs.com/content/dam/tcs/investor-relations/financial-statements/…pdf
 *
 * answers **403 to everyone** (a Chrome User-Agent gets the identical refusal,
 * so it is not UA sniffing, and our fetcher is fine against ordinary public
 * PDFs). `handleFetchUrl` throwing on `!response.ok` is CORRECT behaviour. But
 * because the card also carried a wrong name at the time, an upstream 403 was
 * indistinguishable from our own bug, and anyone retesting with that URL would
 * reasonably conclude the fix had not worked.
 *
 * ## The distinction that matters
 *
 * "The remote host rejected us" and "we could not process what we fetched" need
 * different actions from the user, so they are different kinds here rather than
 * one error string. `retryable` says whether re-running the SAME url could
 * plausibly succeed — a 403 never will, a 429 or a timeout might.
 *
 * ## Why this is a module and not an inline ternary
 *
 * Every message here is user-facing, so every message is built from a fixed
 * template plus a numeric status — never from an error's own text. That keeps
 * stack traces, internal hostnames and GCS paths out of the UI by construction
 * rather than by remembering to sanitise at each call site. The single place
 * that CAN carry arbitrary text (the `internal` fallback) routes through
 * `getSafeErrorMessage`.
 */

// Subpath, not the package root: `@usemoney/utils`'s index pulls in the wider
// util surface, and this module must stay load-pure enough to unit-test without
// booting anything.
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";

/**
 * What went wrong, at the granularity the user can act on.
 *
 * Deliberately coarse: this drives one sentence and a retry affordance, not a
 * support taxonomy. The detail stays in the worker logs.
 */
export type DocumentFailureKind =
  /** The host answered and refused us (4xx/5xx). Not our bug. */
  | "remote_rejected"
  /** We never got an answer — DNS, connect, or the 30s cap. */
  | "remote_unreachable"
  /** Our own SSRF guard refused the target. */
  | "blocked"
  /** The body exceeded the fetch cap. */
  | "too_large"
  /** We fetched something we cannot read. */
  | "unsupported_content"
  /** Anything else — our side. */
  | "internal";

export interface DocumentFailure {
  kind: DocumentFailureKind;
  /**
   * One short sentence for the document card. Safe to render verbatim: it is
   * either a fixed template or a template plus an HTTP status code.
   */
  message: string;
  /** Could re-running this import against the SAME url plausibly succeed? */
  retryable: boolean;
}

/**
 * Thrown by the fetch handlers when the remote host answers with a non-2xx.
 *
 * Carries the numeric status so classification never has to parse a message —
 * `Fetch failed: 403 Forbidden` was the old shape, and regexing it back apart
 * is exactly the stale-copy drift this repo keeps getting bitten by.
 */
export class RemoteFetchError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`Fetch failed: ${status} ${statusText}`);
    this.name = "RemoteFetchError";
    this.status = status;
    this.statusText = statusText;
  }
}

/** Thrown when the bytes arrived but nothing in the pipeline can read them. */
export class UnsupportedContentError extends Error {
  readonly contentType: string;

  constructor(contentType: string) {
    super(`Unsupported content type: ${contentType}`);
    this.name = "UnsupportedContentError";
    this.contentType = contentType;
  }
}

/** Longest reason we persist — the card shows one line, not a paragraph. */
export const MAX_FAILURE_REASON_LENGTH = 200;

/**
 * Name-based rather than `instanceof`.
 *
 * `SsrfBlockedError` lives in @usemoney/core and reaches the worker through a
 * package boundary; under a dual ESM/CJS resolution the same class can be
 * loaded twice, and `instanceof` then silently returns false for a genuine
 * instance. A name check cannot fail that way, and the fallback branch here is
 * "report a generic internal error" — the least useful outcome, which is
 * exactly what a silent mismatch would produce.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/** Did the fetch abort — our own 30s cap, or an aborted signal? */
function isTimeout(error: unknown): boolean {
  const name = errorName(error);
  if (name === "AbortError" || name === "TimeoutError") return true;
  // undici surfaces connect timeouts as a plain Error with a `code`.
  const code = (error as { code?: unknown })?.code;
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "ETIMEDOUT"
  );
}

/** Could we not reach the host at all? */
function isUnreachable(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    errorName(error) === "TypeError" // undici wraps network failures as these
  );
}

/**
 * What to tell the user about a non-2xx from the remote host.
 *
 * Split by what the STATUS means for their next action, which is not the same
 * as the HTTP class: 404 and 403 are both 4xx and both terminal, but one says
 * "fix your link" and the other says "this host will not serve us at all".
 */
function describeStatus(status: number): { message: string; retryable: boolean } {
  if (status === 401 || status === 403) {
    return {
      message:
        `The site refused the request (${status}). It blocks automated ` +
        `downloads, so this link cannot be imported.`,
      retryable: false,
    };
  }
  if (status === 404 || status === 410) {
    return {
      message: `The page was not found (${status}). Check that the link is correct.`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      message: `The site is rate-limiting us (429). Try again in a few minutes.`,
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      message: `The site had a server error (${status}). Try again later.`,
      retryable: true,
    };
  }
  return {
    message: `The site refused the request (${status}).`,
    retryable: false,
  };
}

/**
 * Turn any thrown value into something the document card can show.
 *
 * Never throws, and never returns an empty message — a blank reason on a FAILED
 * card is the exact state MONEY-1168 exists to remove.
 */
export function describeDocumentFailure(error: unknown): DocumentFailure {
  if (error instanceof RemoteFetchError) {
    const { message, retryable } = describeStatus(error.status);
    return { kind: "remote_rejected", message, retryable };
  }

  if (error instanceof UnsupportedContentError) {
    return {
      kind: "unsupported_content",
      message:
        "We downloaded the file but could not read it. Only PDF, text and " +
        "HTML pages can be imported.",
      retryable: false,
    };
  }

  if (errorName(error) === "SsrfBlockedError") {
    // The guard's own reason names internal policy ("Blocked unsafe fetch
    // target: resolved to a private IP") and must not reach the UI. Size is the
    // one case worth separating, because the user CAN act on it.
    const raw = error instanceof Error ? error.message : "";
    if (/exceeds maximum allowed size/i.test(raw)) {
      return {
        kind: "too_large",
        message: "The file is too large to import.",
        retryable: false,
      };
    }
    return {
      kind: "blocked",
      message:
        "That address cannot be fetched for security reasons. Use a public " +
        "https:// link to the file.",
      retryable: false,
    };
  }

  if (isTimeout(error)) {
    return {
      kind: "remote_unreachable",
      message: "The site took too long to respond. Try again later.",
      retryable: true,
    };
  }

  if (isUnreachable(error)) {
    return {
      kind: "remote_unreachable",
      message:
        "We could not reach that site. Check the link, or try again later.",
      retryable: true,
    };
  }

  // Our side. `getSafeErrorMessage` strips the Prisma/driver internals that
  // must never reach a user, and supplies the fallback when there is no
  // message at all.
  return {
    kind: "internal",
    message: truncateReason(
      getSafeErrorMessage(
        error,
        "Something went wrong while processing this document.",
      ),
    ),
    retryable: true,
  };
}

/** Clamp to one card line, cutting on a word boundary where one is close. */
export function truncateReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length <= MAX_FAILURE_REASON_LENGTH) return trimmed;
  const cut = trimmed.slice(0, MAX_FAILURE_REASON_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Only prefer the word boundary when it is not throwing away most of the
  // line — an unbroken 200-char token should still be shown, not reduced to "…".
  const body = lastSpace > MAX_FAILURE_REASON_LENGTH - 40 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
