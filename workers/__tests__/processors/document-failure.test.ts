/**
 * UNIT TEST — document processing failure classification (MONEY-1168).
 *
 * Exercises the REAL exports from workers/src/processors/document-failure.ts.
 *
 * The defect: a failed URL import showed a bare FAILED with size `-` and
 * nothing else, so "the remote host refused us", "the link is wrong" and "our
 * pipeline broke" were indistinguishable. That ambiguity is what made an
 * upstream 403 (tcs.com refuses that asset to every client, Chrome's UA
 * included) look like a bug in this feature.
 *
 * The two properties worth pinning, because both are easy to regress:
 *   1. Every message is user-facing — no stack traces, no internal hostnames,
 *      no GCS paths, no Prisma internals.
 *   2. `retryable` distinguishes "will never work at this URL" (403) from
 *      "might work later" (429, timeout). They are different user actions.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  describeDocumentFailure,
  truncateReason,
  RemoteFetchError,
  UnsupportedContentError,
  MAX_FAILURE_REASON_LENGTH,
} from "../../src/processors/document-failure";

/** Reproduces @usemoney/core's SsrfBlockedError shape without importing it. */
function ssrfError(reason: string): Error {
  const e = new Error(`Blocked unsafe fetch target: ${reason}`);
  e.name = "SsrfBlockedError";
  return e;
}

function codedError(code: string): Error {
  const e = new Error("network");
  (e as Error & { code: string }).code = code;
  return e;
}

describe("describeDocumentFailure — the remote host rejected us", () => {
  test("the tcs.com case: 403 says the site refused us, and is NOT retryable", () => {
    // The exact situation from the report. Retrying this URL can never work,
    // so the copy must not invite a retry.
    const f = describeDocumentFailure(new RemoteFetchError(403, "Forbidden"));
    assert.equal(f.kind, "remote_rejected");
    assert.equal(f.retryable, false);
    assert.match(f.message, /refused the request \(403\)/);
    assert.doesNotMatch(
      f.message,
      /try again/i,
      "a 403 is terminal — telling the user to retry sends them in a loop",
    );
  });

  test("404 points at the link, not at the site's policy", () => {
    const f = describeDocumentFailure(new RemoteFetchError(404, "Not Found"));
    assert.equal(f.retryable, false);
    assert.match(f.message, /not found \(404\)/i);
    assert.match(f.message, /link/i, "the user's action is to check the URL");
  });

  test("429 and 5xx ARE retryable — the distinction the ticket asks for", () => {
    for (const status of [429, 500, 503]) {
      const f = describeDocumentFailure(new RemoteFetchError(status, "x"));
      assert.equal(
        f.retryable,
        true,
        `${status} should be retryable at the same URL`,
      );
      assert.match(f.message, new RegExp(String(status)));
    }
  });

  test("the status is read as a NUMBER, not parsed back out of a message", () => {
    // The old code threw `new Error("Fetch failed: 403 Forbidden")`. Regexing
    // that apart is precisely the stale-copy drift this repo keeps hitting, so
    // the typed error carries the status.
    const e = new RemoteFetchError(451, "Unavailable For Legal Reasons");
    assert.equal(e.status, 451);
    assert.equal(typeof e.status, "number");
    assert.match(describeDocumentFailure(e).message, /\(451\)/);
  });
});

describe("describeDocumentFailure — our side vs the network", () => {
  test("an SSRF block never leaks the guard's internal reason", () => {
    const f = describeDocumentFailure(
      ssrfError("resolved to a private IP 10.1.2.3 (metadata range)"),
    );
    assert.equal(f.kind, "blocked");
    assert.equal(f.retryable, false);
    assert.doesNotMatch(f.message, /10\.1\.2\.3/, "no internal IP in the UI");
    assert.doesNotMatch(f.message, /private IP|metadata/i);
  });

  test("an oversize body is separated from a blocked target", () => {
    // Both arrive as SsrfBlockedError, but only one is something the user can
    // act on, so they must not collapse to the same sentence.
    const f = describeDocumentFailure(
      ssrfError("Response exceeds maximum allowed size"),
    );
    assert.equal(f.kind, "too_large");
    assert.match(f.message, /too large/i);
  });

  test("timeouts and unreachable hosts are retryable", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(describeDocumentFailure(abort).kind, "remote_unreachable");
    assert.equal(describeDocumentFailure(abort).retryable, true);

    for (const code of ["ENOTFOUND", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]) {
      const f = describeDocumentFailure(codedError(code));
      assert.equal(f.kind, "remote_unreachable", `${code} misclassified`);
      assert.equal(f.retryable, true);
    }
  });

  test("unsupported content says we GOT the file but cannot read it", () => {
    const f = describeDocumentFailure(
      new UnsupportedContentError("application/x-7z-compressed"),
    );
    assert.equal(f.kind, "unsupported_content");
    // The ticket's core distinction: this is NOT "the host rejected us".
    assert.match(f.message, /downloaded|could not read/i);
  });

  test("anything else is internal, sanitised, and never empty", () => {
    const f = describeDocumentFailure(
      new Error("PrismaClientKnownRequestError: connect ECONNREFUSED mongo:27017"),
    );
    assert.equal(f.kind, "internal");
    assert.ok(f.message.length > 0, "a blank reason is the bug being fixed");
    assert.doesNotMatch(f.message, /27017|mongo/i, "no infra detail in the UI");
  });

  test("non-Error throws still produce a usable sentence", () => {
    for (const thrown of [undefined, null, "boom", 42, { nope: true }]) {
      const f = describeDocumentFailure(thrown);
      assert.ok(
        f.message.trim().length > 0,
        `throwing ${JSON.stringify(thrown)} produced no reason`,
      );
    }
  });
});

describe("truncateReason", () => {
  test("short reasons are untouched", () => {
    assert.equal(truncateReason("  The site refused us.  "), "The site refused us.");
  });

  test("long reasons are clamped to one card line", () => {
    const out = truncateReason("word ".repeat(200));
    assert.ok(out.length <= MAX_FAILURE_REASON_LENGTH);
    assert.match(out, /…$/);
  });

  test("an unbroken token is still shown rather than reduced to an ellipsis", () => {
    // Guards the word-boundary branch: cutting at the last space would throw
    // away the whole line when there is no space near the limit.
    const out = truncateReason("x".repeat(400));
    assert.ok(out.length > MAX_FAILURE_REASON_LENGTH / 2);
    assert.match(out, /^x+…$/);
  });

  test("every classified message already fits without truncation", () => {
    // If a template ever grows past the cap, the card silently starts showing
    // "…" — better to fail here.
    const samples = [
      describeDocumentFailure(new RemoteFetchError(403, "Forbidden")),
      describeDocumentFailure(new RemoteFetchError(404, "Not Found")),
      describeDocumentFailure(new RemoteFetchError(429, "Too Many")),
      describeDocumentFailure(ssrfError("private IP")),
      describeDocumentFailure(ssrfError("Response exceeds maximum allowed size")),
      describeDocumentFailure(new UnsupportedContentError("application/zip")),
    ];
    for (const s of samples) {
      assert.ok(
        s.message.length <= MAX_FAILURE_REASON_LENGTH,
        `"${s.message}" exceeds the card line budget`,
      );
      assert.doesNotMatch(s.message, /…/);
    }
  });
});
