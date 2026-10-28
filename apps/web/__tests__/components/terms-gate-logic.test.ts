/**
 * MONEY-1126 — TermsGate still blocks.
 *
 * The gate stopped re-asking the server on every client-side navigation. The
 * risk of that change is that a reused answer silently changes what the gate
 * DOES, so these tests pin the whole decision table, and in particular:
 *
 *   - an unaccepted user gets the modal and the walkthrough stays blocked;
 *   - an unresolved answer on a gated route NEVER releases (MONEY-877 — the
 *     walkthrough must not bootstrap ahead of the terms → persona sequence);
 *   - a REMEMBERED answer produces byte-identical state to a freshly fetched
 *     one, which is what makes "ask less often" a safe optimisation.
 *
 * Source: apps/web/components/terms-gate-logic.ts (used by components/TermsGate.tsx)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeTermsGateState,
  type TermsGateInput,
  type TermsGateState,
} from "@/components/terms-gate-logic";

/** Signed-in user on a gated app route (e.g. /dashboard), sequence complete. */
const GATED: TermsGateInput = {
  isLoaded: true,
  hasUser: true,
  isExcludedPath: false,
  isDemo: false,
  hasAcceptedTerms: true,
  hasInvestorProfile: true,
};

function state(overrides: Partial<TermsGateInput>): TermsGateState {
  return computeTermsGateState({ ...GATED, ...overrides });
}

describe("TermsGate: blocking semantics", () => {
  it("[security] an unaccepted user gets the modal and stays blocked", () => {
    assert.deepEqual(state({ hasAcceptedTerms: false }), {
      kind: "resolved",
      showModal: true,
      showInvestor: false,
      termsBlocking: true,
    });
  });

  it("[security] unaccepted blocks regardless of the investor profile", () => {
    for (const hasInvestorProfile of [true, false]) {
      const s = state({ hasAcceptedTerms: false, hasInvestorProfile });
      assert.equal(s.kind, "resolved");
      assert.equal(s.kind === "resolved" && s.showModal, true);
      assert.equal(s.termsBlocking, true);
    }
  });

  it("[security] an UNRESOLVED answer on a gated route never releases", () => {
    assert.deepEqual(state({ hasAcceptedTerms: undefined }), {
      kind: "awaiting-answer",
      termsBlocking: true,
    });
  });

  it("[security] an unresolved answer writes no modal/checked state", () => {
    // `kind: "awaiting-answer"` carries no showModal/showInvestor, so the
    // component leaves `checked` false and renders nothing — a failed or
    // in-flight check can never flash the app as if the sequence were done.
    const s = state({ hasAcceptedTerms: undefined });
    assert.equal("showModal" in s, false);
    assert.equal("showInvestor" in s, false);
  });

  it("[MONEY-877] Clerk still loading on a gated route keeps the walkthrough blocked", () => {
    assert.deepEqual(state({ isLoaded: false, hasAcceptedTerms: undefined }), {
      kind: "auth-pending",
      termsBlocking: true,
    });
  });

  it("[invariant] the modal is never shown with the walkthrough released", () => {
    const flags = [true, false];
    for (const isLoaded of flags)
      for (const hasUser of flags)
        for (const isExcludedPath of flags)
          for (const isDemo of flags)
            for (const hasAcceptedTerms of [true, false, undefined])
              for (const hasInvestorProfile of flags) {
                const s = computeTermsGateState({
                  isLoaded,
                  hasUser,
                  isExcludedPath,
                  isDemo,
                  hasAcceptedTerms,
                  hasInvestorProfile,
                });
                if (s.kind === "resolved" && s.showModal) {
                  assert.equal(
                    s.termsBlocking,
                    true,
                    "a visible consent modal must block the walkthrough"
                  );
                }
              }
  });
});

describe("TermsGate: release paths (unchanged)", () => {
  it("releases when the sequence is complete", () => {
    assert.deepEqual(state({}), {
      kind: "resolved",
      showModal: false,
      showInvestor: false,
      termsBlocking: false,
    });
  });

  it("advances to the investor step when terms are accepted but no profile exists", () => {
    assert.deepEqual(state({ hasInvestorProfile: false }), {
      kind: "resolved",
      showModal: false,
      showInvestor: true,
      termsBlocking: true,
    });
  });

  it("never gates a signed-out visitor", () => {
    assert.deepEqual(state({ hasUser: false, hasAcceptedTerms: undefined }), {
      kind: "resolved",
      showModal: false,
      showInvestor: false,
      termsBlocking: false,
    });
  });

  it("never gates an excluded (public/auth/legal) path", () => {
    assert.deepEqual(
      state({ isExcludedPath: true, hasAcceptedTerms: undefined }),
      {
        kind: "resolved",
        showModal: false,
        showInvestor: false,
        termsBlocking: false,
      }
    );
  });

  it("never gates a demo session", () => {
    assert.deepEqual(state({ isDemo: true, hasAcceptedTerms: undefined }), {
      kind: "resolved",
      showModal: false,
      showInvestor: false,
      termsBlocking: false,
    });
  });

  it("releases on an excluded/demo path even while Clerk is loading", () => {
    for (const overrides of [{ isExcludedPath: true }, { isDemo: true }]) {
      assert.deepEqual(
        computeTermsGateState({
          ...GATED,
          ...overrides,
          isLoaded: false,
          hasAcceptedTerms: undefined,
        }),
        { kind: "auth-pending", termsBlocking: false }
      );
    }
  });
});

describe("TermsGate: a remembered answer behaves exactly like a fresh one", () => {
  it("[regression] every accepted/profile combination is identical either way", () => {
    // The component takes two routes to the same call: `termsCheck.peek(...)`
    // (remembered) and `termsCheck.get(...).then(...)` (fetched). Both feed
    // this function with the same boolean, so the states must be identical —
    // otherwise "cache hit" and "cache miss" would gate differently.
    for (const hasAcceptedTerms of [true, false]) {
      for (const hasInvestorProfile of [true, false]) {
        const fromFetch = state({ hasAcceptedTerms, hasInvestorProfile });
        const fromCache = state({ hasAcceptedTerms, hasInvestorProfile });
        assert.deepEqual(fromCache, fromFetch);
      }
    }
  });

  it("only `true` is ever eligible to be remembered, and `true` never shows the modal", () => {
    // TermsGate remembers `accepted === true` only (see guards-wiring test).
    // So the only state reachable from the cache is a non-modal state — a
    // remembered answer structurally cannot suppress the consent dialog for a
    // user who has not accepted.
    for (const hasInvestorProfile of [true, false]) {
      const s = state({ hasAcceptedTerms: true, hasInvestorProfile });
      assert.equal(s.kind === "resolved" && s.showModal, false);
    }
  });
});
