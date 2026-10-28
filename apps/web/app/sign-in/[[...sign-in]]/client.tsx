"use client";

/**
 * Sign-in page — custom headless Clerk flow (MONEY-484).
 *
 * Flow:
 *  1. Google / Apple OAuth → authenticateWithRedirect → /sso-callback → /dashboard
 *  2. Email + password → signIn.create → on "complete" → setActive → /dashboard
 *  3. If secondFactorRequired → show 6-digit TOTP form → attemptSecondFactor
 *  4. "Forgot password?" → /forgot-password
 *
 * Preserves: TradingView credit, "POWERED BY CLERK · ENCRYPTED" footer,
 * AuthShell layout (back-to-home + theme toggle), OneTapGate coexistence.
 */

import {
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { useAuth, useClerk } from "@clerk/nextjs";
// Clerk v7: the default `useSignIn` is now the signals-based API. This custom
// sign-in flow uses the classic resource methods (signIn.create /
// attemptSecondFactor / authenticateWithRedirect + setActive), so it imports the
// legacy hook to preserve v5/v6 behavior unchanged.
import { useSignIn } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { ArrowRight } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import { GoogleGlyph, AppleGlyph } from "@/components/auth/OAuthGlyphs";
import {
  resolveSignInNextStep,
  pickClientTrustFactor,
  type ClientTrustFactor,
} from "@/components/auth/client-trust";

// ── helpers ──────────────────────────────────────────────────────────────

function firstClerkMessage(err: unknown): string {
  if (isClerkAPIResponseError(err)) {
    const code = err.errors[0]?.code;
    // Security — account enumeration: never reveal whether an account exists.
    // Collapse "no account with that email" and "wrong password" into ONE
    // identical message so an attacker can't probe which emails are registered.
    if (
      code === "form_identifier_not_found" ||
      code === "form_password_incorrect"
    ) {
      return "The email or password you entered is incorrect.";
    }
    return (
      err.errors[0]?.longMessage ??
      err.errors[0]?.message ??
      "Something went wrong. Please try again."
    );
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

/** First Clerk error code (e.g. "not_allowed_access"), if any. */
function clerkErrorCode(err: unknown): string | undefined {
  return isClerkAPIResponseError(err) ? err.errors[0]?.code : undefined;
}

// ── 2FA sub-form ──────────────────────────────────────────────────────────

function TotpForm({
  onVerify,
  loading,
  error,
  eyebrow = "TWO-FACTOR AUTHENTICATION",
  title,
  sub = "Open your authenticator app and type the current code.",
  onResend,
}: {
  onVerify: (code: string) => void;
  loading: boolean;
  error: string;
  eyebrow?: string;
  title?: React.ReactNode;
  sub?: React.ReactNode;
  onResend?: () => void;
}) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);

  function handleInput(idx: number, val: string) {
    // Accept only digits; handle paste of full code
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
    // Auto-focus next box
    if (cleaned && idx < 5) {
      const el = document.getElementById(`totp-${idx + 1}`);
      if (el) (el as HTMLInputElement).focus();
    }
    if (next.every((d) => d !== "")) {
      onVerify(next.join(""));
    }
  }

  function handleKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      const el = document.getElementById(`totp-${idx - 1}`);
      if (el) (el as HTMLInputElement).focus();
    }
  }

  return (
    <div style={{ marginTop: 28, maxWidth: 460 }}>
      <div className="auth-eyebrow">
        <span className="d" />
        {eyebrow}
      </div>
      <h1 className="auth-h1" style={{ fontSize: 36 }}>
        {title ?? (
          <>
            Enter your <span className="ser">six-digit</span>{" "}
            <span className="hl">auth code.</span>
          </>
        )}
      </h1>
      <div className="auth-sub">{sub}</div>

      <div className="auth-otp-row">
        {digits.map((d, i) => (
          <input
            key={i}
            id={`totp-${i}`}
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={d}
            className="auth-otp-box"
            onChange={(e) => handleInput(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            disabled={loading}
            autoFocus={i === 0}
            aria-label={`Digit ${i + 1}`}
          />
        ))}
      </div>

      {error && <div className="auth-error">{error}</div>}

      <button
        type="button"
        className="auth-cta"
        style={{ marginTop: 24 }}
        onClick={() => onVerify(digits.join(""))}
        disabled={loading || digits.join("").length < 6}
      >
        {loading ? <span className="auth-spinner" /> : null}
        Verify &amp; continue
        <ArrowRight size={15} />
      </button>

      {onResend && (
        <button
          type="button"
          className="auth-link"
          style={{
            marginTop: 14,
            background: "none",
            border: 0,
            cursor: "pointer",
            color: "var(--ink-3)",
            fontSize: 13,
            textDecoration: "underline",
            padding: 0,
          }}
          onClick={onResend}
          disabled={loading}
        >
          Resend code
        </button>
      )}
    </div>
  );
}

// ── Main sign-in form ─────────────────────────────────────────────────────

export default function SignInPage() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const { isSignedIn } = useAuth();
  const clerk = useClerk();
  const oauthCallbackRan = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<"google" | "apple" | null>(
    null
  );
  const [error, setError] = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);
  // Client Trust (MONEY-766): non-MFA password sign-in from a NEW device —
  // Clerk returns status "needs_client_trust" and we verify a code sent to
  // the account email/phone via the second-factor pair.
  const [trustFactor, setTrustFactor] = useState<ClientTrustFactor | null>(
    null
  );

  // Already-signed-in (or just-completed sign-in) → go to the dashboard. Hard
  // nav so the freshly-set session cookie is sent and middleware doesn't
  // bounce back to /sign-in.
  useEffect(() => {
    if (isSignedIn) window.location.href = "/launch";
  }, [isSignedIn]);

  // MONEY-878: surface a reason bounced back from /sso-callback. A restricted
  // account (Clerk allowlist — enforced on Clerk's backend, so it never got a
  // session) returns ?error=access_restricted; show WHY instead of a blank
  // retry that looks broken. Read from window to avoid a useSearchParams
  // Suspense boundary.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code === "access_restricted") {
      setError(
        "This email isn’t allowed to access UseMoney yet. If you believe this is a mistake, contact support@usemoney.ai."
      );
    } else if (code === "oauth") {
      setError("Sign-in didn’t complete. Please try again.");
    }
  }, []);

  // MONEY-881: finish the Google OAuth round-trip ON this page — no separate
  // /sso-callback. Google redirects back to /sign-in; the flag set in
  // handleOAuth tells us to run handleRedirectCallback with the button still
  // spinning. Gated on the REACTIVE `isLoaded` so the callback actually fires
  // once Clerk is ready, and consumed once via the flag + ref.
  useEffect(() => {
    if (!isLoaded || oauthCallbackRan.current) return;
    const key =
      typeof window !== "undefined"
        ? sessionStorage.getItem("oauthReturn")
        : null;
    if (key !== "google" && key !== "apple") return;
    oauthCallbackRan.current = true;
    sessionStorage.removeItem("oauthReturn");
    setOauthLoading(key);
    clerk
      .handleRedirectCallback({
        signInForceRedirectUrl: "/launch",
        signUpForceRedirectUrl: "/dashboard",
        continueSignUpUrl: "/sign-up",
      })
      .catch((err: unknown) => {
        setOauthLoading(null);
        setError(
          clerkErrorCode(err) === "not_allowed_access"
            ? "This email isn’t allowed to access UseMoney yet. If you believe this is a mistake, contact support@usemoney.ai."
            : "Sign-in didn’t complete. Please try again."
        );
      });
  }, [isLoaded, clerk]);

  // ── OAuth ──────────────────────────────────────────────────────────────
  async function handleOAuth(provider: "oauth_google" | "oauth_apple") {
    if (!isLoaded || !signIn) return;
    const key = provider === "oauth_google" ? "google" : "apple";
    setOauthLoading(key);
    setError("");
    try {
      // Return to /sign-in (not a separate /sso-callback page) so the user stays
      // here with the button spinner while the effect above completes the OAuth.
      sessionStorage.setItem("oauthReturn", key);
      await signIn.authenticateWithRedirect({
        strategy: provider,
        redirectUrl: "/sign-in",
        redirectUrlComplete: "/launch",
        // Force Google's account chooser instead of silently auto-selecting the
        // browser's single signed-in account (oidcPrompt → OAuth `prompt`).
        oidcPrompt: "select_account",
      });
    } catch (err) {
      sessionStorage.removeItem("oauthReturn");
      setError(firstClerkMessage(err));
      setOauthLoading(null);
    }
  }

  // ── Email + password ───────────────────────────────────────────────────
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn || !setActive) return;
    setLoading(true);
    setError("");
    try {
      const result = await signIn.create({
        identifier: email.trim(),
        password,
      });

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        window.location.href = "/launch";
        return;
      }

      // Second factor required (TOTP / backup code)
      if (result.status === "needs_second_factor") {
        setNeeds2FA(true);
        setLoading(false);
        return;
      }

      // New-device verification (Client Trust, MONEY-766)
      if (resolveSignInNextStep(result.status) === "client_trust") {
        await startClientTrust(result.supportedSecondFactors);
        setLoading(false);
        return;
      }

      // Unhandled status — surface it
      setError(
        `Unexpected sign-in status: ${result.status ?? "unknown"}. Please try again.`
      );
    } catch (err) {
      if (
        isClerkAPIResponseError(err) &&
        err.errors[0]?.code === "session_exists"
      ) {
        window.location.href = "/launch";
        return;
      }
      setError(firstClerkMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // ── Client Trust (new-device) challenge ──────────────────────────────
  async function startClientTrust(supportedSecondFactors: unknown) {
    if (!signIn) return;
    const factor = pickClientTrustFactor(supportedSecondFactors);
    if (!factor) {
      setError(
        "This sign-in needs a new-device verification, but no email or phone is available for it. Please contact support."
      );
      return;
    }
    try {
      // Clerk's published types can trail the Client Trust rollout — the
      // runtime (>= @clerk/nextjs 7.0) accepts the email_code/phone_code
      // second-factor prepare params per the dashboard's minimum-versions
      // table, so the params are narrowed through the method's own type.
      await signIn.prepareSecondFactor({
        strategy: factor.strategy,
        ...(factor.emailAddressId
          ? { emailAddressId: factor.emailAddressId }
          : {}),
        ...(factor.phoneNumberId
          ? { phoneNumberId: factor.phoneNumberId }
          : {}),
      } as unknown as Parameters<typeof signIn.prepareSecondFactor>[0]);
      setTrustFactor(factor);
    } catch (err) {
      setError(firstClerkMessage(err));
    }
  }

  async function handleTrustVerify(code: string) {
    if (!isLoaded || !signIn || !setActive || !trustFactor) return;
    if (code.length < 6) return;
    setLoading(true);
    setError("");
    try {
      const result = await signIn.attemptSecondFactor({
        strategy: trustFactor.strategy,
        code,
      } as unknown as Parameters<typeof signIn.attemptSecondFactor>[0]);
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        window.location.href = "/launch";
        return;
      }
      setError("Verification failed. Please try again.");
    } catch (err) {
      if (
        isClerkAPIResponseError(err) &&
        err.errors[0]?.code === "session_exists"
      ) {
        window.location.href = "/launch";
        return;
      }
      setError(firstClerkMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function resendTrustCode() {
    if (!trustFactor) return;
    setError("");
    await startClientTrust([trustFactor]);
  }

  // ── 2FA verify ────────────────────────────────────────────────────────
  async function handle2FA(code: string) {
    if (!isLoaded || !signIn || !setActive) return;
    if (code.length < 6) return;
    setLoading(true);
    setError("");
    try {
      const result = await signIn.attemptSecondFactor({
        strategy: "totp",
        code,
      });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        window.location.href = "/launch";
        return;
      }
      // Defensive: Client Trust normally targets non-MFA sign-ins, but if
      // Clerk ever chains it after TOTP, route it instead of dead-ending.
      if (resolveSignInNextStep(result.status) === "client_trust") {
        setNeeds2FA(false);
        await startClientTrust(result.supportedSecondFactors);
        return;
      }
      setError("Verification failed. Please try again.");
    } catch (err) {
      if (
        isClerkAPIResponseError(err) &&
        err.errors[0]?.code === "session_exists"
      ) {
        window.location.href = "/launch";
        return;
      }
      setError(firstClerkMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (isSignedIn) {
    return (
      <AuthShell kind="in">
        <div className="auth-eyebrow" style={{ marginTop: 48 }}>
          <span className="d" />
          REDIRECTING TO DASHBOARD…
        </div>
      </AuthShell>
    );
  }

  if (trustFactor) {
    const dest = trustFactor.safeIdentifier
      ? ` to ${trustFactor.safeIdentifier}`
      : trustFactor.strategy === "email_code"
        ? " to your email"
        : " to your phone";
    return (
      <AuthShell kind="in">
        <div className="auth-brand">
          <span className="brand-mark">U</span>
          <span>
            UseMoney<span className="brand-ai"> AI</span>
          </span>
        </div>

        <TotpForm
          onVerify={handleTrustVerify}
          loading={loading}
          error={error}
          eyebrow="NEW DEVICE · QUICK CHECK"
          title={
            <>
              Verify <span className="ser">this device</span>{" "}
              <span className="hl">to continue.</span>
            </>
          }
          sub={`You're signing in from a new device, so we sent a six-digit code${dest}. Enter it below.`}
          onResend={resendTrustCode}
        />

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
            <Link href="/sign-in">← Back to sign-in</Link>
          </span>
        </div>
      </AuthShell>
    );
  }

  if (needs2FA) {
    return (
      <AuthShell kind="in">
        <div className="auth-brand">
          <span className="brand-mark">U</span>
          <span>
            UseMoney<span className="brand-ai"> AI</span>
          </span>
        </div>

        <TotpForm onVerify={handle2FA} loading={loading} error={error} />

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
            <Link href="/sign-in">← Back to sign-in</Link>
          </span>
        </div>
      </AuthShell>
    );
  }

  const globallyLoading = loading || oauthLoading !== null;

  return (
    <AuthShell kind="in">
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
          SIGN IN · WELCOME BACK
        </div>
        <h1 className="auth-h1">
          Welcome back, <span className="ser">let&apos;s see</span>{" "}
          <span className="hl">today&apos;s tape.</span>
        </h1>
        <div className="auth-sub">
          Markets are moving. Pick up right where you left off — your whole
          portfolio, one workspace.
        </div>
      </div>

      {/* Form area */}
      <div style={{ marginTop: 8 }}>
        {/* OAuth buttons */}
        <div className="auth-oauth-row">
          <button
            type="button"
            className="auth-oauth-btn"
            onClick={() => handleOAuth("oauth_google")}
            disabled={!isLoaded || globallyLoading}
            aria-label="Continue with Google"
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
            Continue with Google
          </button>
          <button
            type="button"
            className="auth-oauth-btn"
            disabled
            aria-label="Continue with Apple — coming soon"
            title="Apple sign-in is coming soon"
          >
            <AppleGlyph />
            Continue with Apple
            <span className="auth-soon">SOON</span>
          </button>
        </div>

        {/* A Google sign-in that transfers into a new sign-up may require a
            bot-protection CAPTCHA — Clerk renders it into this element. */}
        <div id="clerk-captcha" />

        <div className="auth-or">OR · EMAIL &amp; PASSWORD</div>

        <form onSubmit={handleSubmit} noValidate>
          {/* Email */}
          <div className="auth-field">
            <label htmlFor="si-email">Email address</label>
            <input
              id="si-email"
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

          {/* Password */}
          <div className="auth-field">
            <label htmlFor="si-password">
              Password
              <Link href="/forgot-password">Forgot password?</Link>
            </label>
            <input
              id="si-password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="auth-input"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={globallyLoading}
              required
            />
          </div>

          {/* Error */}
          {error && <div className="auth-error">{error}</div>}

          {/* CTA */}
          <button
            type="submit"
            className="auth-cta"
            disabled={!isLoaded || globallyLoading || !email || !password}
          >
            {loading ? <span className="auth-spinner" /> : null}
            Sign in
            <ArrowRight size={15} />
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
        <span>New to UseMoney?</span>
        <Link href="/sign-up" className="auth-create">
          Create a free account
          <ArrowRight size={13} />
        </Link>
      </div>
    </AuthShell>
  );
}
