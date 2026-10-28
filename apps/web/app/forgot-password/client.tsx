"use client";

/**
 * Forgot-password page — custom headless Clerk flow (MONEY-484).
 *
 * Flow:
 *  Step 1: User enters email.
 *          → signIn.create({ strategy: "reset_password_email_code", identifier })
 *  Step 2: 6-digit code entry.
 *          → signIn.attemptFirstFactor({ strategy: "reset_password_email_code", code })
 *          → Clerk returns status "needs_new_password"
 *  Step 3: New password entry.
 *          → signIn.resetPassword({ password })
 *          → On complete → setActive → /dashboard.
 *
 * Matches design: coral eyebrow, italic hero, "Protected by Clerk" info box,
 * "LINK EXPIRES IN 30 MIN" footer badge. Both light + dark themes via auth.css vars.
 */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import {
  resolveSignInNextStep,
  pickClientTrustFactor,
  type ClientTrustFactor,
} from "@/components/auth/client-trust";
import Link from "next/link";
import { useRouter } from "next/navigation";
// Clerk v7 switched the default `useSignIn` to the new signals-based API
// (SignInFutureResource, no `isLoaded`/`setActive`). This custom reset-password
// flow uses the classic resource methods (signIn.create / attemptFirstFactor /
// resetPassword + setActive), so it imports the legacy hook, which preserves the
// v5/v6 behavior unchanged.
import { useSignIn } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { ArrowRight, Send, ShieldCheck } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import { getPasswordStrength } from "@/components/auth/usePasswordStrength";

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

// ── Step 2: code entry ────────────────────────────────────────────────────

function CodeStep({
  onSubmitCode,
  loading,
  error,
  variant = "reset",
}: {
  onSubmitCode: (code: string) => void;
  loading: boolean;
  error: string;
  /**
   * "reset" — the password-reset email code (default copy).
   * "device" — the Client Trust new-device verification (MONEY-766): after
   * the password is set, Clerk can require a code for an untrusted client.
   */
  variant?: "reset" | "device";
}) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);

  function handleDigit(idx: number, val: string) {
    const cleaned = val.replace(/\D/g, "");
    if (cleaned.length >= 6) {
      const arr = cleaned.slice(0, 6).split("");
      setDigits(arr);
      onSubmitCode(arr.join(""));
      return;
    }
    const next = [...digits];
    next[idx] = cleaned.slice(-1);
    setDigits(next);
    if (cleaned && idx < 5) {
      const el = document.getElementById(`rp-${idx + 1}`);
      if (el) (el as HTMLInputElement).focus();
    }
    if (next.every((d) => d !== "")) {
      onSubmitCode(next.join(""));
    }
  }

  function handleKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      const el = document.getElementById(`rp-${idx - 1}`);
      if (el) (el as HTMLInputElement).focus();
    }
  }

  return (
    <AuthShell kind="forgot">
      <div className="auth-brand">
        <span className="brand-mark">U</span>
        <span>
          UseMoney<span className="brand-ai"> AI</span>
        </span>
      </div>

      <div style={{ marginTop: 30, maxWidth: 480 }}>
        <div className="auth-eyebrow coral">
          <span className="d" />
          {variant === "device"
            ? "NEW DEVICE · QUICK CHECK"
            : "RESET PASSWORD · CHECK YOUR INBOX"}
        </div>
        <h1 className="auth-h1">
          {variant === "device" ? (
            <>
              Verify <span className="ser">this device</span>{" "}
              <span className="hl">to continue.</span>
            </>
          ) : (
            <>
              Enter the <span className="ser">six-digit</span>{" "}
              <span className="hl">reset code.</span>
            </>
          )}
        </h1>
        <div className="auth-sub">
          {variant === "device"
            ? "Password updated — one more step: you're on a new device, so we emailed a six-digit verification code."
            : "Check your inbox for the code. It expires in 30 minutes."}
        </div>

        <div className="auth-otp-row">
          {digits.map((d, i) => (
            <input
              key={i}
              id={`rp-${i}`}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={d}
              className="auth-otp-box"
              onChange={(e) => handleDigit(i, e.target.value)}
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
          onClick={() => onSubmitCode(digits.join(""))}
          disabled={loading || digits.join("").length < 6}
        >
          {loading ? <span className="auth-spinner" /> : null}
          Verify code
          <ArrowRight size={15} />
        </button>
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
          <Link href="/sign-in">← Back to sign-in</Link>
        </span>
        <span className="auth-clerk">
          <span className="d" />
          LINK EXPIRES IN 30 MIN
        </span>
      </div>
    </AuthShell>
  );
}

// ── Step 3: new password ──────────────────────────────────────────────────

function NewPasswordStep({
  onSetPassword,
  loading,
  error,
}: {
  onSetPassword: (newPassword: string) => void;
  loading: boolean;
  error: string;
}) {
  const [newPassword, setNewPassword] = useState("");
  const strength = getPasswordStrength(newPassword);

  const fillClass = (seg: number): string => {
    if (seg >= strength.score) return "";
    return `filled-${Math.min(strength.score - 1, 3)}`;
  };

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSetPassword(newPassword);
  }

  return (
    <AuthShell kind="forgot">
      <div className="auth-brand">
        <span className="brand-mark">U</span>
        <span>
          UseMoney<span className="brand-ai"> AI</span>
        </span>
      </div>

      <div style={{ marginTop: 30, maxWidth: 480 }}>
        <div className="auth-eyebrow coral">
          <span className="d" />
          RESET PASSWORD · ALMOST THERE
        </div>
        <h1 className="auth-h1">
          Pick a <span className="ser">new password</span>{" "}
          <span className="hl">and you&apos;re in.</span>
        </h1>
        <div className="auth-sub">
          Choose something strong — at least 8 characters with a mix of types.
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="auth-field" style={{ marginTop: 28 }}>
            <label htmlFor="np-password">New password</label>
            <input
              id="np-password"
              name="password"
              type="password"
              autoComplete="new-password"
              className="auth-input"
              placeholder="Make it strong"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={loading}
              required
            />
            {newPassword.length > 0 && (
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

          {error && <div className="auth-error">{error}</div>}

          <button
            type="submit"
            className="auth-cta"
            style={{ marginTop: 22 }}
            disabled={loading || newPassword.length < 8}
          >
            {loading ? <span className="auth-spinner" /> : null}
            Reset password &amp; sign in
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

      <div className="auth-foot">
        <span>
          <Link href="/sign-in">← Back to sign-in</Link>
        </span>
        <span className="auth-clerk">
          <span className="d" />
          LINK EXPIRES IN 30 MIN
        </span>
      </div>
    </AuthShell>
  );
}

// ── Step 1: email entry ───────────────────────────────────────────────────

type FpStep = "email" | "code" | "password" | "trust";

export default function ForgotPasswordClient() {
  const router = useRouter();
  const { isLoaded, signIn, setActive } = useSignIn();

  const [step, setStep] = useState<FpStep>("email");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  // Client Trust (MONEY-766): the post-reset sign-in can require a
  // new-device verification code.
  const [trustFactor, setTrustFactor] = useState<ClientTrustFactor | null>(
    null
  );
  const [trustError, setTrustError] = useState("");
  const [trustLoading, setTrustLoading] = useState(false);

  // ── Send reset email ──────────────────────────────────────────────────
  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn) return;
    setLoading(true);
    setError("");
    try {
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email.trim(),
      });
      setStep("code");
    } catch (err) {
      // Security — account enumeration: a non-existent email must look IDENTICAL
      // to a real one. Clerk throws form_identifier_not_found here; swallow it
      // and advance to the code step exactly as on success (no code is sent, so
      // a bogus email simply can't get past it). Other errors surface normally.
      if (
        isClerkAPIResponseError(err) &&
        err.errors[0]?.code === "form_identifier_not_found"
      ) {
        setStep("code");
      } else {
        setError(firstClerkMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }

  // ── Verify code ───────────────────────────────────────────────────────
  async function handleCode(code: string) {
    if (!isLoaded || !signIn) return;
    if (code.length < 6) return;
    setCodeLoading(true);
    setCodeError("");
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code,
      });
      // Clerk returns needs_new_password status → move to password step
      if (
        result.status === "needs_new_password" ||
        result.status === "complete"
      ) {
        if (result.status === "complete" && setActive) {
          await setActive({ session: result.createdSessionId });
          router.push("/dashboard");
          return;
        }
        setStep("password");
      } else {
        setCodeError("Invalid code. Please try again.");
      }
    } catch (err) {
      setCodeError(firstClerkMessage(err));
    } finally {
      setCodeLoading(false);
    }
  }

  // ── Set new password ──────────────────────────────────────────────────
  async function handleSetPassword(newPassword: string) {
    if (!isLoaded || !signIn || !setActive) return;
    setPwLoading(true);
    setPwError("");
    try {
      const result = await signIn.resetPassword({ password: newPassword });

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/dashboard");
        return;
      }

      // Client Trust (MONEY-766): password updated, but this new device
      // still needs a verification code before the session is created.
      if (resolveSignInNextStep(result.status) === "client_trust") {
        const factor = pickClientTrustFactor(result.supportedSecondFactors);
        if (!factor) {
          setPwError(
            "Your password was updated, but this device needs verification and no email or phone is available for it. Please sign in again."
          );
          return;
        }
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
        setStep("trust");
        return;
      }

      setPwError(
        `Unexpected status: ${result.status ?? "unknown"}. Please try again.`
      );
    } catch (err) {
      setPwError(firstClerkMessage(err));
    } finally {
      setPwLoading(false);
    }
  }

  // ── New-device verification (Client Trust) ───────────────────────────
  async function handleTrustCode(code: string) {
    if (!isLoaded || !signIn || !setActive || !trustFactor) return;
    if (code.length < 6) return;
    setTrustLoading(true);
    setTrustError("");
    try {
      const result = await signIn.attemptSecondFactor({
        strategy: trustFactor.strategy,
        code,
      } as unknown as Parameters<typeof signIn.attemptSecondFactor>[0]);
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/dashboard");
        return;
      }
      setTrustError("Verification failed. Please try again.");
    } catch (err) {
      setTrustError(firstClerkMessage(err));
    } finally {
      setTrustLoading(false);
    }
  }

  if (step === "trust") {
    return (
      <CodeStep
        variant="device"
        onSubmitCode={handleTrustCode}
        loading={trustLoading}
        error={trustError}
      />
    );
  }

  // ── Show code step ────────────────────────────────────────────────────
  if (step === "code") {
    return (
      <CodeStep
        onSubmitCode={handleCode}
        loading={codeLoading}
        error={codeError}
      />
    );
  }

  // ── Show new-password step ────────────────────────────────────────────
  if (step === "password") {
    return (
      <NewPasswordStep
        onSetPassword={handleSetPassword}
        loading={pwLoading}
        error={pwError}
      />
    );
  }

  // ── Step 1 render ─────────────────────────────────────────────────────
  return (
    <AuthShell kind="forgot">
      <div className="auth-brand">
        <span className="brand-mark">U</span>
        <span>
          UseMoney<span className="brand-ai"> AI</span>
        </span>
      </div>

      <div style={{ marginTop: 30, maxWidth: 480 }}>
        {/* Coral eyebrow per design */}
        <div className="auth-eyebrow coral">
          <span className="d" />
          FORGOT PASSWORD · NO DRAMA
        </div>
        <h1 className="auth-h1">
          It happens. <span className="ser">We&apos;ll send</span> a{" "}
          <span className="hl">reset link.</span>
        </h1>
        <div className="auth-sub">
          Type the email you signed up with. The code is single-use and expires
          in 30 minutes.
        </div>

        <form onSubmit={handleSend} noValidate>
          <div className="auth-field" style={{ marginTop: 28 }}>
            <label htmlFor="fp-email">Email address</label>
            <input
              id="fp-email"
              name="emailAddress"
              type="email"
              autoComplete="email"
              className="auth-input"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button
            type="submit"
            className="auth-cta"
            style={{ marginTop: 22 }}
            disabled={!isLoaded || loading || !email}
          >
            {loading ? <span className="auth-spinner" /> : null}
            Email me the code
            <Send size={13} />
          </button>
        </form>

        {/* "Protected by Clerk" info box per design */}
        <div className="auth-clerk-box">
          <div
            className="ttl"
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <ShieldCheck size={12} color="var(--emerald)" />
            PROTECTED BY CLERK
          </div>
          <div className="body">
            We rate-limit reset codes to one every 60 seconds. Your account
            isn&apos;t locked while you reset — you can still sign in if you
            remember the old password.
          </div>
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
          <Link href="/sign-in">← Back to sign-in</Link>
        </span>
        <span className="auth-clerk">
          <span className="d" />
          LINK EXPIRES IN 30 MIN
        </span>
      </div>
    </AuthShell>
  );
}
