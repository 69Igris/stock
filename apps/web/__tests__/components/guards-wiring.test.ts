/**
 * MONEY-1126 — SessionGuard / TermsGate stopped re-firing per navigation.
 *
 * `__tests__/utils/once-per-user-cache.test.ts` proves the MECHANISM: a value
 * the caller declines to remember is re-asked every time, a rejection is never
 * remembered, and the slot is keyed by user id. This file pins what the two
 * guards actually HAND that mechanism, so the two together are the safety
 * argument:
 *
 *   SessionGuard remembers only `ghosted === false` ⇒ a ghosted session and a
 *   failed check are both re-checked on the next navigation, exactly as before.
 *
 *   TermsGate remembers only `accepted === true` ⇒ the only user the modal
 *   blocks is the one whose answer is never cached.
 *
 * Source-level because the property is "what predicate is wired in", which no
 * render can observe. Behaviour lives in the two files named above and in
 * `terms-gate-logic.test.ts`.
 *
 * Sources: apps/web/components/{SessionGuard,TermsGate}.tsx,
 *          apps/web/lib/utils/once-per-user-cache.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

/** Comments stripped — these assertions are about wires, not prose. */
function code(rel: string): string {
  return (
    read(rel)
      // MONEY-1143 — LINE before BLOCK; see the note in the sibling suites.
      .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}

describe("SessionGuard: quieter, not weaker", () => {
  const src = code("components/SessionGuard.tsx");

  it("[security] remembers ONLY a DETERMINED healthy session", () => {
    // `determined` is the half that actually protects the gate. Review of this
    // branch found that keying on the boolean alone was unsafe: the action
    // never rejects — it converts a DB failure into the non-blocking `ghosted:
    // false` — so the once-per-user helper's "a rejection is never remembered"
    // rule protected nothing, and one transient error was cached as "healthy",
    // disabling the check for the rest of the page load.
    assert.match(
      src,
      /shouldRemember:\s*\(r\)\s*=>\s*r\.determined\s*&&\s*r\.ghosted\s*===\s*false/,
      "only a determined, healthy answer may be remembered"
    );
  });

  it("[security] the ghost check runs through the cache, never bare", () => {
    // A bare `isSessionGhostedAction()` call anywhere would reintroduce the
    // per-navigation round trip.
    assert.doesNotMatch(src, /isSessionGhostedAction\(\)/);
    assert.match(
      src,
      /ghostCheck\s*\n?\s*\.get\(\s*user\.id\s*,\s*isSessionGhostedAction\s*\)/
    );
  });

  it("[security] still signs out a ghosted session", () => {
    assert.match(src, /if\s*\(cancelled\s*\|\|\s*!ghosted\)\s*return;/);
    assert.match(src, /signOut\(\{\s*redirectUrl:\s*"\/"\s*\}\)/);
  });

  it("[security] still stays silent on errors (never signs out a healthy user)", () => {
    assert.match(src, /\.catch\(/);
  });

  it("still skips demo + public/auth routes on every navigation", () => {
    // The route/demo skips are NOT cached — a user who reaches a checked route
    // later in the session is still checked there.
    assert.match(src, /pathname\.startsWith\("\/sign-in"\)/);
    assert.match(src, /tradebook_demo_mode/);
  });

  it("[security] keyed by the Clerk user id, so it cannot span accounts", () => {
    assert.match(src, /ghostCheck\.peek\(user\.id\)/);
  });
});

describe("TermsGate: quieter, not weaker", () => {
  const src = code("components/TermsGate.tsx");

  it("[security] remembers ONLY a DETERMINED accepted answer", () => {
    // See the SessionGuard note: `hasAcceptedTermsAction` fails OPEN (any error
    // becomes `accepted: true`), so remembering the bare boolean cached the
    // error default and left a compliance gate open for the rest of the page
    // load even after the database recovered.
    assert.match(
      src,
      /shouldRemember:\s*\(r\)\s*=>\s*r\.determined\s*&&\s*r\.accepted\s*===\s*true/,
      "only a determined, accepted answer may be remembered"
    );
  });

  it("[security] the terms check runs through the cache, never bare", () => {
    assert.doesNotMatch(src, /hasAcceptedTermsAction\(\)/);
    assert.match(
      src,
      /termsCheck\s*\n?\s*\.get\(\s*clerkUserId\s*,\s*hasAcceptedTermsAction\s*\)/
    );
  });

  it("[security] a transport failure no longer becomes an unhandled rejection, and does not release", () => {
    // The previous `.then()` chain had no `.catch()` at all. The handler must
    // exist and must NOT call `apply(...)` — leaving the synchronous
    // `awaiting-answer` block in place.
    const catchBlock = src.match(/\.catch\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/);
    assert.ok(catchBlock, "the terms check must handle a rejection");
    assert.doesNotMatch(
      catchBlock[1],
      /apply\(|setTermsBlocking\(false\)|setChecked/,
      "a failed check must not resolve or release the gate"
    );
  });

  it("[security] both the cached and the fetched answer go through the same decision table", () => {
    assert.match(
      src,
      /computeTermsGateState\(\{\s*\.\.\.base,\s*hasAcceptedTerms:\s*known\.accepted\s*\}\)/
    );
    assert.match(
      src,
      /computeTermsGateState\(\{\s*\.\.\.base,\s*hasAcceptedTerms:\s*accepted\s*\}\)/
    );
  });

  it("[MONEY-877] still blocks the walkthrough synchronously before asking", () => {
    assert.match(
      src,
      /apply\(computeTermsGateState\(\{\s*\.\.\.base,\s*hasAcceptedTerms:\s*undefined\s*\}\)\);\s*\n\s*let cancelled/
    );
  });

  it("[security] keyed by the Clerk user id", () => {
    assert.match(src, /const clerkUserId = user\.id;/);
    assert.match(src, /termsCheck\.peek\(clerkUserId\)/);
  });
});

describe("the shared resolver is memory-only", () => {
  it("[security] never persists an answer anywhere a later user could read it", () => {
    const src = code("lib/utils/once-per-user-cache.ts");
    assert.doesNotMatch(
      src,
      /localStorage|sessionStorage|document\.cookie|indexedDB/
    );
  });

  it("[security] holds a single slot, so it cannot accumulate accounts", () => {
    const src = code("lib/utils/once-per-user-cache.ts");
    assert.match(
      src,
      /let settled:\s*\{\s*userId: string;\s*value: T\s*\}\s*\|\s*null/
    );
    assert.doesNotMatch(src, /new Map|new Set/);
  });
});
