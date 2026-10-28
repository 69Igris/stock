"use client";

/**
 * Sign-up page — custom headless Clerk flow (MONEY-484).
 *
 * Flow (3 steps):
 *  Step 1 — Account: firstName + lastName + email + password
 *            OR Google / Apple OAuth
 *  Step 2 — Verify: 6-digit OTP boxes (email_code)
 *  Step 3 — Complete: setActive → /dashboard
 *
 * Preserved:
 *  - SignUpDeletionToast (listens on blur for /api/auth/signup-precheck)
 *  - Clerk CAPTCHA element (<div id="clerk-captcha" />) for bot protection
 *  - TradingView credit, footer text
 *  - AuthShell (back + theme toggle + brand panel)
 *
 * Error messages from layout.tsx localization (form_identifier_exists etc.)
 * surface automatically through err.errors[0].longMessage.
 */

import { useState, useEffect, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { capturePromoFromUrl } from "@/lib/promo";
// Clerk v7: the default `useSignUp` is now the signals-based API. This custom
// sign-up flow uses the classic resource methods (signUp.create /
// prepareEmailAddressVerification / attemptEmailAddressVerification +
// setActive), so it imports the legacy hook to preserve v5/v6 behavior
// unchanged.
import { useSignUp } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { ArrowRight } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import { SignUpDeletionToast } from "@/components/auth/SignUpDeletionToast";
import { GoogleGlyph, AppleGlyph } from "@/components/auth/OAuthGlyphs";
import { getPasswordStrength } from "@/components/auth/usePasswordStrength";

// ── helpers ────────────────────────────────────────────────────────────────

function firstClerkMessage(err: unknown): string {
  if (isClerkAPIResponseError(err)) {
    return (
      err.errors[0]?.longMessage ??
      err.errors[0]?.message ??
      "Something went wrong. Please try again."
    );
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

// ── OTP verify step ────────────────────────────────────────────────────────

function VerifyStep({
  email,
  onVerify,
  onResend,
  onChangeEmail,
  loading,
  error,
}: {
  email: string;
  onVerify: (code: string) => void;
  onResend: () => void;
  onChangeEmail: () => void;
  loading: boolean;
  error: string;
}) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [resendCountdown, setResendCountdown] = useState(30);

  // Countdown timer
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  function handleInput(idx: number, val: string) {
    const cleaned = val.replace(/\D/g, "");
    if (cleaned.length >= 6) {
      const arr = cleaned.slice(0, 6).split("");
      setDigits(arr);
      onVerify(arr.join(""));
      return;
    }
    const next = [...digits];
    next[idx] = cleaned.slice(-1);
    setDigits(next);
    if (cleaned && idx < 5) {
      const el = document.getElementById(`otp-${idx + 1}`);
      if (el) (el as HTMLInputElement).focus();
    }
    if (next.every((d) => d !== "")) {
      onVerify(next.join(""));
    }
  }

  function handleKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      const el = document.getElementById(`otp-${idx - 1}`);
      if (el) (el as HTMLInputElement).focus();
    }
  }

  function handleResend() {
    setResendCountdown(30);
    setDigits(["", "", "", "", "", ""]);
    onResend();
  }

  return (
    <AuthShell kind="verify">
      <div className="auth-brand">
        <span className="brand-mark">U</span>
        <span>
          UseMoney<span className="brand-ai"> AI</span>
        </span>
      </div>

      <div style={{ marginTop: 30, maxWidth: 460 }}>
        {/* Step indicator */}
        <div className="auth-eyebrow">
          <span className="d" />
          STEP 2 OF 3 · VERIFY YOUR EMAIL
        </div>
        <div className="auth-step" style={{ marginTop: 12 }}>
          <span className="s done" />
          <span className="s active" />
          <span className="s" />
        </div>
        <div className="auth-step-label">STEP 2 OF 3 · VERIFY</div>

        <h1 className="auth-h1" style={{ fontSize: 38 }}>
          Check your <span className="ser">inbox.</span>{" "}
          <span className="hl">Six digits</span> incoming.
        </h1>
        <div className="auth-sub">
          We just sent a code to{" "}
          <strong
            style={{
              fontStyle: "normal",
              fontFamily: "Inter, sans-serif",
              color: "var(--ink)",
            }}
          >
            {email}
          </strong>
          . Paste it below.
        </div>

        {/* OTP digit boxes */}
        <div className="auth-otp-row">
          {digits.map((d, i) => (
            <input
              key={i}
              id={`otp-${i}`}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={d}
              className="auth-otp-box"
              onChange={(e) => handleInput(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              disabled={loading}
              autoFocus={i === 0}
              aria-label={`Code digit ${i + 1}`}
            />
          ))}
        </div>

        {error && <div className="auth-error">{error}</div>}

        <button
          type="button"
          className="auth-cta"
          style={{ marginTop: 28 }}
          onClick={() => onVerify(digits.join(""))}
          disabled={loading || digits.join("").length < 6}
        >
          {loading ? <span className="auth-spinner" /> : null}
          Verify &amp; continue
          <ArrowRight size={15} />
        </button>

        <div className="auth-resend-row">
          Didn&apos;t get it?{" "}
          {resendCountdown > 0 ? (
            <button type="button" disabled>
              Resend in {resendCountdown}s
            </button>
          ) : (
            <button type="button" onClick={handleResend}>
              Resend code
            </button>
          )}{" "}
          ·{" "}
          <button type="button" onClick={onChangeEmail}>
            Use a different email
          </button>
        </div>
      </div>

      <p className="auth-tv">
        Charts powered by{" "}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          TradingView
        </a>
      </p>

      <div className="auth-foot">
        <span>
          <button
            type="button"
            onClick={onChangeEmail}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "inherit",
              color: "var(--emerald)",
              textDecoration: "underline",
              textUnderlineOffset: 2,
              fontWeight: 600,
            }}
          >
            ← Back to sign-up
          </button>
        </span>
        <span className="auth-clerk">
          <span className="d" />
          CODES EXPIRE IN 10 MIN
        </span>
      </div>
    </AuthShell>
  );
}

// ── Step 1: account creation form ─────────────────────────────────────────

export default function SignUpPage() {
  const { isLoaded, signUp, setActive } = useSignUp();
  const { isSignedIn } = useAuth();

  // Form state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<"google" | "apple" | null>(
    null
  );
  const [error, setError] = useState("");

  // Verification step
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [verifyLoading, setVerifyLoading] = useState(false);

  // Already-signed-in (or just-completed signup) → dashboard. Hard nav so the
  // freshly-set session cookie is sent and middleware doesn't bounce back.
  useEffect(() => {
    if (isSignedIn) window.location.href = "/dashboard";
  }, [isSignedIn]);

  // MONEY-385: capture a ?promo=CODE so the post-signup in-app upgrade pre-fills
  // the coupon.
  useEffect(() => {
    capturePromoFromUrl();
  }, []);

  // MONEY-878: a NEW OAuth user "signing up via the sign-in flow" is transferred
  // by Clerk into a sign-up; when the provider didn't supply every required
  // field (Clerk's continueSignUpUrl on /sso-callback points here) the SignUp
  // lands with status="missing_requirements". Resume it — collect ONLY what's
  // missing, with NO password (OAuth users have none) — instead of re-rendering
  // the full create form (which would ask a Google user for a password).
  const [continuing, setContinuing] = useState(false);
  useEffect(() => {
    if (!isLoaded || !signUp) return;
    const unverified = signUp.unverifiedFields ?? [];
    // A transferred OAuth sign-up already has a provider-verified email; an
    // in-progress email/password sign-up still lists email_address as
    // unverified — that case is the verify step below, not this one.
    if (
      signUp.status === "missing_requirements" &&
      !unverified.includes("email_address")
    ) {
      setContinuing(true);
      if (signUp.firstName) setFirstName(signUp.firstName);
      if (signUp.lastName) setLastName(signUp.lastName);
      if (signUp.emailAddress) setEmail(signUp.emailAddress);
    }
  }, [isLoaded, signUp]);

  const strength = getPasswordStrength(password);

  // Strength bar fill class per segment
  const fillClass = (seg: number): string => {
    if (seg >= strength.score) return "";
    return `filled-${Math.min(strength.score - 1, 3)}`;
  };

  // ── OAuth ────────────────────────────────────────────────────────────
  async function handleOAuth(provider: "oauth_google" | "oauth_apple") {
    if (!isLoaded || !signUp) return;
    const key = provider === "oauth_google" ? "google" : "apple";
    setOauthLoading(key);
    setError("");
    try {
      await signUp.authenticateWithRedirect({
        strategy: provider,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/dashboard",
        // Force Google's account chooser instead of silently auto-selecting the
        // browser's single signed-in account (oidcPrompt → OAuth `prompt`).
        oidcPrompt: "select_account",
      });
    } catch (err) {
      setError(firstClerkMessage(err));
      setOauthLoading(null);
    }
  }

  // ── Submit account ────────────────────────────────────────────────────
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    if (strength.score < 2) {
      setError("Please choose a stronger password (8+ chars, mix of types).");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await signUp.create({
        emailAddress: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });

      // Prepare email code verification
      await signUp.prepareEmailAddressVerification({
        strategy: "email_code",
      });

      setVerifying(true);
    } catch (err) {
      if (
        isClerkAPIResponseError(err) &&
        err.errors[0]?.code === "session_exists"
      ) {
        window.location.href = "/dashboard";
        return;
      }
      setError(firstClerkMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // ── Finish a transferred OAuth sign-up (missing profile fields) ────────
  async function handleContinueSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp || !setActive) return;
    setLoading(true);
    setError("");
    try {
      const updated = await signUp.update({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });
      if (updated.status === "complete") {
        await setActive({ session: updated.createdSessionId });
        window.location.href = "/dashboard";
        return;
      }
      // Something other than name is still required (e.g. a custom field this
      // step doesn't collect) — fail clearly instead of looping.
      setError(
        "We couldn’t finish creating your account. Please contact support@usemoney.ai."
      );
    } catch (err) {
      setError(firstClerkMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // ── Verify OTP ────────────────────────────────────────────────────────
  async function handleVerify(code: string) {
    if (!isLoaded || !signUp || !setActive) return;
    if (code.length < 6) return;
    setVerifyLoading(true);
    setVerifyError("");
    try {
      const result = await signUp.attemptEmailAddressVerification({ code });

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        window.location.href = "/dashboard";
        return;
      }

      setVerifyError(
        `Unexpected status: ${result.status ?? "unknown"}. Please try again.`
      );
    } catch (err) {
      setVerifyError(firstClerkMessage(err));
    } finally {
      setVerifyLoading(false);
    }
  }

  // ── Resend code ───────────────────────────────────────────────────────
  async function handleResend() {
    if (!isLoaded || !signUp) return;
    try {
      await signUp.prepareEmailAddressVerification({
        strategy: "email_code",
      });
    } catch (err) {
      setVerifyError(firstClerkMessage(err));
    }
  }

  // ── Change email (go back to step 1) ─────────────────────────────────
  function handleChangeEmail() {
    setVerifying(false);
    setVerifyError("");
  }

  // ── Redirect already-signed-in users ─────────────────────────────────
  if (isSignedIn) {
    return (
      <AuthShell kind="up">
        <div className="auth-eyebrow" style={{ marginTop: 48 }}>
          <span className="d" />
          REDIRECTING TO DASHBOARD…
        </div>
      </AuthShell>
    );
  }

  // ── Continue a transferred OAuth sign-up (collect missing details) ─────
  if (continuing) {
    return (
      <AuthShell kind="up">
        <div className="auth-brand">
          <span className="brand-mark">U</span>
          <span>
            UseMoney<span className="brand-ai"> AI</span>
          </span>
        </div>

        <div style={{ marginTop: 30, maxWidth: 460 }}>
          <div className="auth-eyebrow">
            <span className="d" />
            ALMOST THERE · FINISH SETUP
          </div>
          <h1 className="auth-h1">
            Just a couple <span className="ser">more details.</span>
          </h1>
          <div className="auth-sub">
            You&apos;re signing up
            {email ? (
              <>
                {" "}
                as{" "}
                <strong style={{ fontStyle: "normal", color: "var(--ink)" }}>
                  {email}
                </strong>
              </>
            ) : null}
            . Confirm your name to finish.
          </div>

          <form
            onSubmit={handleContinueSubmit}
            noValidate
            style={{ marginTop: 20 }}
          >
            <div className="auth-name-grid">
              <div className="auth-field" style={{ marginTop: 0 }}>
                <label htmlFor="ct-first">First name</label>
                <input
                  id="ct-first"
                  type="text"
                  autoComplete="given-name"
                  className="auth-input"
                  placeholder="Rahul"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
              <div className="auth-field" style={{ marginTop: 0 }}>
                <label htmlFor="ct-last">Last name</label>
                <input
                  id="ct-last"
                  type="text"
                  autoComplete="family-name"
                  className="auth-input"
                  placeholder="Vora"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
            </div>

            {error && <div className="auth-error">{error}</div>}

            <button
              type="submit"
              className="auth-cta"
              disabled={loading || !firstName || !lastName}
            >
              {loading ? <span className="auth-spinner" /> : null}
              Finish &amp; continue
              <ArrowRight size={15} />
            </button>
          </form>
        </div>

        <p className="auth-tv">
          Charts powered by{" "}
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            TradingView
          </a>
        </p>
      </AuthShell>
    );
  }

  // ── Verify step ───────────────────────────────────────────────────────
  if (verifying) {
    return (
      <VerifyStep
        email={email.trim()}
        onVerify={handleVerify}
        onResend={handleResend}
        onChangeEmail={handleChangeEmail}
        loading={verifyLoading}
        error={verifyError}
      />
    );
  }

  const globallyLoading = loading || oauthLoading !== null;

  // ── Step 1 render ─────────────────────────────────────────────────────
  return (
    <AuthShell kind="up">
      {/* Brand mark */}
      <div className="auth-brand">
        <span className="brand-mark">U</span>
        <span>
          UseMoney<span className="brand-ai"> AI</span>
        </span>
      </div>

      {/* Hero */}
      <div style={{ marginTop: 30 }}>
        <div className="auth-eyebrow">
          <span className="d" />
          CREATE ACCOUNT · 60 SECONDS · NO CARD
        </div>

        {/* Step dots */}
        <div className="auth-step" style={{ marginTop: 12 }}>
          <span className="s active" />
          <span className="s" />
          <span className="s" />
        </div>
        <div className="auth-step-label">STEP 1 OF 3 · ACCOUNT</div>

        <h1 className="auth-h1">
          Start <span className="ser">free, forever.</span>{" "}
          <span className="hl">No card needed.</span>
        </h1>
        <div className="auth-sub">
          5 free Sage credits a month. Connect a broker in 60 seconds. PRO is{" "}
          <strong>₹249/mo</strong> when you want more.
        </div>
      </div>

      {/* Deletion toast — listens for blur on email fields */}
      <SignUpDeletionToast />

      {/* Form area */}
      <div style={{ marginTop: 8 }}>
        {/* OAuth buttons */}
        <div className="auth-oauth-row">
          <button
            type="button"
            className="auth-oauth-btn"
            onClick={() => handleOAuth("oauth_google")}
            disabled={!isLoaded || globallyLoading}
            aria-label="Sign up with Google"
          >
            {oauthLoading === "google" ? (
              <span
                className="auth-spinner"
                style={{
                  borderColor: "var(--ink-3)",
                  borderTopColor: "#4285F4",
                }}
              />
            ) : (
              <GoogleGlyph />
            )}
            Sign up with Google
          </button>
          <button
            type="button"
            className="auth-oauth-btn"
            disabled
            aria-label="Sign up with Apple — coming soon"
            title="Apple sign-in is coming soon"
          >
            <AppleGlyph />
            Sign up with Apple
            <span className="auth-soon">SOON</span>
          </button>
        </div>

        <div className="auth-or">OR · EMAIL &amp; PASSWORD</div>

        <form onSubmit={handleSubmit} noValidate>
          {/* Name row */}
          <div className="auth-name-grid">
            <div className="auth-field" style={{ marginTop: 0 }}>
              <label htmlFor="su-first">First name</label>
              <input
                id="su-first"
                name="firstName"
                type="text"
                autoComplete="given-name"
                className="auth-input"
                placeholder="Rahul"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={globallyLoading}
                required
              />
            </div>
            <div className="auth-field" style={{ marginTop: 0 }}>
              <label htmlFor="su-last">Last name</label>
              <input
                id="su-last"
                name="lastName"
                type="text"
                autoComplete="family-name"
                className="auth-input"
                placeholder="Vora"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={globallyLoading}
                required
              />
            </div>
          </div>

          {/* Email — SignUpDeletionToast listens via capture blur */}
          <div className="auth-field">
            <label htmlFor="su-email">Email address</label>
            <input
              id="su-email"
              name="emailAddress"
              type="email"
              autoComplete="email"
              className="auth-input"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={globallyLoading}
              required
            />
          </div>

          {/* Password + strength meter */}
          <div className="auth-field">
            <label htmlFor="su-password">
              Password{" "}
              <span
                style={{ fontWeight: 500, color: "var(--ink-3)", fontSize: 11 }}
              >
                · 8+ chars, mix of types
              </span>
            </label>
            <input
              id="su-password"
              name="password"
              type="password"
              autoComplete="new-password"
              className="auth-input"
              placeholder="Make it good"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={globallyLoading}
              required
            />
            {password.length > 0 && (
              <>
                <div className="auth-strength-bar">
                  {[0, 1, 2, 3].map((seg) => (
                    <div key={seg} className={`seg ${fillClass(seg)}`} />
                  ))}
                </div>
                <div className="auth-strength-label">{strength.label}</div>
              </>
            )}
          </div>

          {/* Clerk CAPTCHA — required for bot protection in headless flow */}
          <div id="clerk-captcha" />

          {/* Error */}
          {error && <div className="auth-error">{error}</div>}

          {/* CTA */}
          <button
            type="submit"
            className="auth-cta"
            disabled={
              !isLoaded ||
              globallyLoading ||
              !email ||
              !password ||
              !firstName ||
              !lastName
            }
          >
            {loading ? <span className="auth-spinner" /> : null}
            Create account → next: verify email
          </button>
        </form>
      </div>

      {/* TradingView credit */}
      <p className="auth-tv">
        Charts powered by{" "}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          TradingView
        </a>
      </p>

      {/* Footer */}
      <div className="auth-foot">
        <span>Already have an account?</span>
        <Link href="/sign-in" className="auth-create">
          Sign in
          <ArrowRight size={13} />
        </Link>
      </div>
    </AuthShell>
  );
}
