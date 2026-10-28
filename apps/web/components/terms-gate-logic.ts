/**
 * TermsGate decision table — MONEY-1126.
 *
 * Extracted from `components/TermsGate.tsx` (mirroring the
 * `components/page-guard-logic.ts` precedent) so the compliance gate's
 * behaviour is asserted directly rather than inferred. The component is a thin
 * dispatcher over this function; the branch bodies are unchanged from the
 * pre-extraction version.
 *
 * The property that matters, and that the tests lock in: the state produced
 * from a REMEMBERED answer is identical to the state produced from a freshly
 * fetched one. Reusing an answer changes how often we ask, never what we do
 * with it.
 */

/** What the gate should be showing, given everything known right now. */
export type TermsGateState =
  /**
   * Clerk is still resolving. MONEY-877: do NOT release the walkthrough in this
   * transient window — releasing here lets WalkthroughProvider bootstrap the
   * tour BEFORE the terms → persona sequence. Modal/investor/checked are left
   * untouched; the effect re-runs when `isLoaded` flips.
   */
  | { kind: "auth-pending"; termsBlocking: boolean }
  /**
   * Gated route, signed-in user, server answer not in yet. Block the
   * walkthrough synchronously so it cannot race the consent dialog, and show
   * nothing until the answer arrives.
   */
  | { kind: "awaiting-answer"; termsBlocking: true }
  /** Final state for this navigation. */
  | {
      kind: "resolved";
      showModal: boolean;
      showInvestor: boolean;
      termsBlocking: boolean;
    };

export interface TermsGateInput {
  /** Clerk `isLoaded`. */
  isLoaded: boolean;
  /** Clerk has a signed-in user. */
  hasUser: boolean;
  /** Pathname is in TERMS_GATE_EXCLUDED_PATHS (public/auth/legal). */
  isExcludedPath: boolean;
  /** `tradebook_demo_mode` — demo users browse with a cookie, not an account. */
  isDemo: boolean;
  /**
   * Server answer from `hasAcceptedTermsAction`. `undefined` = not resolved
   * yet (in flight, or the call rejected). Never optimistically `true`.
   */
  hasAcceptedTerms: boolean | undefined;
  /** Clerk `unsafeMetadata.investorProfile` is present. */
  hasInvestorProfile: boolean;
}

export function computeTermsGateState(input: TermsGateInput): TermsGateState {
  const {
    isLoaded,
    hasUser,
    isExcludedPath,
    isDemo,
    hasAcceptedTerms,
    hasInvestorProfile,
  } = input;

  // Excluded/demo paths never gate, so release there even while loading.
  const ungated = isExcludedPath || isDemo;

  if (!isLoaded) {
    return { kind: "auth-pending", termsBlocking: !ungated };
  }

  if (!hasUser || ungated) {
    // Not on a gated route → walkthrough is free to start.
    return {
      kind: "resolved",
      showModal: false,
      showInvestor: false,
      termsBlocking: false,
    };
  }

  // Gated route. The answer is async (~150ms), and WalkthroughProvider reacts
  // to the same pathname change and calls isTermsBlocking() — so an unresolved
  // answer must block, not pass.
  if (hasAcceptedTerms === undefined) {
    return { kind: "awaiting-answer", termsBlocking: true };
  }

  if (!hasAcceptedTerms) {
    // Step 1 — terms.
    return {
      kind: "resolved",
      showModal: true,
      showInvestor: false,
      termsBlocking: true,
    };
  }

  if (!hasInvestorProfile) {
    // Step 2 — investor-level capture (terms already accepted).
    return {
      kind: "resolved",
      showModal: false,
      showInvestor: true,
      termsBlocking: true,
    };
  }

  // Sequence complete → walkthrough may start.
  return {
    kind: "resolved",
    showModal: false,
    showInvestor: false,
    termsBlocking: false,
  };
}
