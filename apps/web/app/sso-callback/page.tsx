"use client";

/**
 * SSO callback for the headless OAuth flow (Google / Apple).
 *
 * MONEY-877 — custom handler (not the prebuilt <SignIn>) so a brand-new OAuth
 * user (no account yet) is TRANSFERRED into a sign-up via continueSignUpUrl /
 * signUpForceRedirectUrl instead of hanging.
 *
 * MONEY-878 — hardened to Clerk's canonical custom-flow guidance
 * (https://clerk.com/docs/guides/development/custom-flows/authentication/oauth-connections):
 *
 *  1. `hasRun` ref + a REACTIVE `isLoaded` (useAuth) gate so the callback runs
 *     EXACTLY once and only after Clerk has loaded. NOTE: gating on the
 *     NON-reactive `clerk.loaded` with a `[clerk]` dep was a bug — the effect
 *     never re-ran when Clerk finished loading, so handleRedirectCallback never
 *     fired: the page hung on "Signing you in…" forever AND no account was
 *     created (hence no welcome email). `useAuth().isLoaded` flips false→true
 *     and re-renders, so the effect re-runs. hasRun still guards Strict Mode's
 *     double invoke (whose 2nd call would leak an unhandled rejection).
 *
 *  2. `<div id="clerk-captcha">` — a sign-in transferred to a sign-up may need
 *     bot-protection CAPTCHA; without the element Clerk warns and the verify
 *     path is unreliable.
 *
 *  3. Error handling that distinguishes Clerk's `not_allowed_access` — the
 *     allowlist/blocklist restriction. That check is enforced on Clerk's
 *     BACKEND (a blocked user can never obtain a session regardless of client
 *     code), so we do NOT re-check it here; we only surface WHY access was
 *     denied so the user sees a clear message instead of a silent hang or a
 *     bounce-loop back into sign-in.
 */
import { useEffect, useRef } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";

/** First Clerk error code (e.g. "not_allowed_access") off a rejection, if any. */
function clerkErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "errors" in err) {
    const errors = (err as { errors?: Array<{ code?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) return errors[0]?.code;
  }
  return undefined;
}

export default function SSOCallbackPage() {
  const clerk = useClerk();
  // Reactive — re-renders this component when Clerk finishes loading, so the
  // effect below re-runs and the callback actually fires (see note 1 above).
  const { isLoaded } = useAuth();
  const hasRun = useRef(false);

  useEffect(() => {
    if (!isLoaded || hasRun.current) return;
    hasRun.current = true;

    // MONEY-881: log the lifecycle so a future failure is diagnosable from the
    // console immediately (the real Clerk error was buried during this bug).
    console.info(
      "[sso-callback] Clerk loaded → running handleRedirectCallback"
    );

    clerk
      .handleRedirectCallback({
        signInForceRedirectUrl: "/launch",
        signUpForceRedirectUrl: "/dashboard",
        continueSignUpUrl: "/sign-up",
      })
      .catch((err: unknown) => {
        // Never hang. Log the REAL error, then surface a reason the sign-in page
        // renders. `not_allowed_access` = Clerk allowlist restriction (backend-
        // enforced); anything else is a generic OAuth failure.
        const code = clerkErrorCode(err);
        console.error(
          `[sso-callback] handleRedirectCallback failed (code=${code ?? "none"}):`,
          err
        );
        const reason =
          code === "not_allowed_access" ? "access_restricted" : "oauth";
        window.location.href = `/sign-in?error=${reason}`;
      });
  }, [isLoaded, clerk]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontSize: 13,
        color: "var(--ink-3, #888)",
      }}
    >
      Signing you in…
      {/* Required: a sign-in transferred to a sign-up may need CAPTCHA. */}
      <div id="clerk-captcha" />
    </div>
  );
}
