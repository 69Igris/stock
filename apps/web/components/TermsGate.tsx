"use client";

/**
 * TermsGate - client component that checks if the authenticated user
 * has accepted the platform terms. If not, renders the TermsAcceptanceModal
 * on top of the page content.
 *
 * The modal is suppressed on public/legal pages so that when the user
 * clicks a tab in the modal (e.g. "Terms of Service" → opens /terms in
 * a new tab), they can read the full document without the modal blocking
 * it. The modal only appears on authenticated app routes (/dashboard,
 * /holdings, /brokers, etc.).
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import TermsAcceptanceModal from "./TermsAcceptanceModal";
import WelcomeWizardClient from "@/app/welcome/client";
import { hasAcceptedTermsAction } from "@/lib/actions/user";
import { setTermsBlocking } from "@/lib/walkthrough/terms-signal";
import { TERMS_GATE_EXCLUDED_PATHS as EXCLUDED_PATHS } from "@/lib/route-lists";
import { computeTermsGateState, type TermsGateState } from "./terms-gate-logic";
import { createOncePerUserCache } from "@/lib/utils/once-per-user-cache";

// MONEY-1126: the effect keys on `pathname`, so `hasAcceptedTermsAction` fired
// once per client-side navigation forever. Acceptance is monotonic — a user who
// has accepted never un-accepts — so a DETERMINED accepted answer is reused for
// the page load. A not-accepted answer is never remembered, which is what keeps
// the gate from getting weaker: the only user the modal blocks is the one whose
// answer we re-ask for every single time, exactly as before. Memory only, keyed
// by Clerk user id (see `once-per-user-cache`).
//
// `determined` is what makes that true. `hasAcceptedTermsAction` never rejects —
// it turns any failure into the NON-blocking `accepted: true` — so the helper's
// "a rejection is never remembered" rule protects nothing here by itself.
// Remembering the bare boolean meant a single DB hiccup was cached as
// "accepted" and the terms gate stayed open for the rest of the page load, on a
// compliance surface, even after the database recovered.
const termsCheck = createOncePerUserCache<{
  accepted: boolean;
  determined: boolean;
}>({
  shouldRemember: (r) => r.determined && r.accepted === true,
});

// Routes where the terms modal should NEVER appear (public/auth/legal pages the
// user must be able to read before accepting) live in the dependency-free
// `@/lib/route-lists` module, imported above as EXCLUDED_PATHS, so the list
// can't drift from the sidebar's public routes or the route-access test.
function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PATHS.some(
    (excluded) => pathname === excluded || pathname.startsWith(excluded + "/")
  );
}

export default function TermsGate({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser();
  const pathname = usePathname();
  const [showModal, setShowModal] = useState(false);
  const [showInvestor, setShowInvestor] = useState(false);
  const [checked, setChecked] = useState(false);

  // Investor profile is captured by the /welcome wizard and stored in Clerk
  // unsafeMetadata. The onboarding sequence is: accept terms → capture
  // investor level → walkthrough. Each step keeps the walkthrough blocked.
  const hasInvestorProfile = Boolean(user?.unsafeMetadata?.investorProfile);

  useEffect(() => {
    // Skip for demo sessions - demo users browse with a cookie, not a real account
    const isDemo =
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true";

    const base = {
      isLoaded,
      hasUser: Boolean(user),
      isExcludedPath: isExcludedPath(pathname),
      isDemo,
      hasInvestorProfile,
    };

    /** Push a computed decision into React state. */
    const apply = (state: TermsGateState) => {
      if (state.kind === "resolved") {
        setShowModal(state.showModal);
        setShowInvestor(state.showInvestor);
        setChecked(true);
      }
      setTermsBlocking(state.termsBlocking);
    };

    // Auth pending, signed out, or an ungated (excluded/demo) path — no server
    // call at all, same as before.
    if (!isLoaded || !user || base.isExcludedPath || base.isDemo) {
      apply(computeTermsGateState({ ...base, hasAcceptedTerms: undefined }));
      return;
    }

    // Gated route with a signed-in user. A terms answer already accepted this
    // page load resolves synchronously — which also removes the frame in which
    // the walkthrough was re-blocked and then immediately released again.
    const clerkUserId = user.id;
    const known = termsCheck.peek(clerkUserId);
    if (known !== undefined) {
      apply(
        computeTermsGateState({ ...base, hasAcceptedTerms: known.accepted })
      );
      return;
    }

    // Answer not in yet → block synchronously so the walkthrough waits for the
    // whole sequence, then ask.
    apply(computeTermsGateState({ ...base, hasAcceptedTerms: undefined }));

    let cancelled = false;
    termsCheck
      .get(clerkUserId, hasAcceptedTermsAction)
      .then(({ accepted }) => {
        if (cancelled) return;
        apply(computeTermsGateState({ ...base, hasAcceptedTerms: accepted }));
      })
      .catch(() => {
        // Transport failure. Leave the gate exactly where the synchronous
        // `awaiting-answer` above put it — blocked, unchecked, no modal — which
        // is what the previous un-caught `.then()` chain also produced, minus
        // the unhandled rejection. The answer is not remembered, so the next
        // navigation retries.
      });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, user, pathname, hasInvestorProfile]);

  // Terms accepted → advance to the investor-profile step, or release the
  // walkthrough if the profile already exists.
  const handleAccepted = () => {
    setShowModal(false);
    if (!hasInvestorProfile) {
      setShowInvestor(true);
      setTermsBlocking(true);
    } else {
      setTermsBlocking(false);
    }
  };

  // Investor level captured → sequence done, release the walkthrough.
  const handleInvestorDone = () => {
    setShowInvestor(false);
    setTermsBlocking(false);
  };

  return (
    <>
      {children}
      {checked && showModal && (
        <TermsAcceptanceModal onAccepted={handleAccepted} />
      )}
      {checked && !showModal && showInvestor && (
        <WelcomeWizardClient embedded onComplete={handleInvestorDone} />
      )}
    </>
  );
}
