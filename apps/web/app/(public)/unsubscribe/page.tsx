import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  verifyUnsubscribeToken,
  removeFromNewsletterAudience,
} from "@usemoney/email";
// Pull the playful marketing tokens (cream/ink, dot-grid, emerald accent)
// so this page matches the public marketing site shell.
import "../../(marketing)/playful.css";
import "./unsubscribe.css";
import { ResubscribeButton } from "./ResubscribeButton";

export const metadata: Metadata = {
  title: "Unsubscribe — UseMoney Newsletter",
  description: "Manage your UseMoney newsletter subscription.",
  robots: { index: false, follow: false },
};

// This page is intentionally never cached — every visit must re-validate the
// token and reflect the latest subscription status.
export const dynamic = "force-dynamic";

interface UnsubscribePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// ---------------------------------------------------------------------------
// Server Component — unsubscribe is handled server-side for instant feedback.
// Only the "Resubscribe" button is a client island (needs fetch).
// ---------------------------------------------------------------------------

export default async function UnsubscribePage({
  searchParams,
}: UnsubscribePageProps) {
  const params = await searchParams;

  const rawEmail = typeof params.email === "string" ? params.email : null;
  const rawToken = typeof params.token === "string" ? params.token : null;

  // ── 1. Missing params ──────────────────────────────────────────────────
  if (!rawEmail || !rawToken) {
    return (
      <UnsubscribeShell>
        <ErrorState
          icon="?"
          title="Link not found"
          body="This unsubscribe link appears to be incomplete. Links in our emails
            contain both an email address and a security token."
          cta={<SettingsLink />}
        />
      </UnsubscribeShell>
    );
  }

  const email = decodeURIComponent(rawEmail).toLowerCase().trim();
  const token = rawToken;

  // ── 2. HMAC token validation ───────────────────────────────────────────
  if (!verifyUnsubscribeToken(email, token)) {
    return (
      <UnsubscribeShell>
        <ErrorState
          icon="!"
          title="Invalid or expired link"
          body="The unsubscribe link is invalid or has already been used. This can
            happen if the link was modified or is from an old email."
          cta={<SettingsLink />}
        />
      </UnsubscribeShell>
    );
  }

  // ── 3. DB lookup ───────────────────────────────────────────────────────
  const subscriber = await prisma.newsletterSubscriber.findUnique({
    where: { email },
  });

  // Already unsubscribed — idempotent, show confirmation not an error.
  if (!subscriber || subscriber.status === "UNSUBSCRIBED") {
    return (
      <UnsubscribeShell>
        <AlreadyUnsubscribed email={email} />
      </UnsubscribeShell>
    );
  }

  // ── 4. Perform unsubscribe ─────────────────────────────────────────────
  try {
    await prisma.newsletterSubscriber.update({
      where: { email },
      data: {
        status: "UNSUBSCRIBED",
        unsubscribedAt: new Date(),
      },
    });

    // Audience-sync: remove from the newsletter audience in Resend so future
    // broadcasts don't reach this address. Fire-and-forget — DB update already
    // succeeded; a Resend hiccup does not fail the page render.
    removeFromNewsletterAudience({ email }).catch((err: unknown) => {
      console.error("[Public Unsubscribe] Resend audience sync failed:", err);
    });
  } catch (err) {
    console.error("[Public Unsubscribe] DB update failed:", err);
    return (
      <UnsubscribeShell>
        <ErrorState
          icon="x"
          title="Something went wrong"
          body="We could not process your unsubscribe request right now. Please try
            again in a moment or contact us if the problem persists."
          cta={
            <a href="mailto:support@usemoney.ai" className="btn-flat">
              Contact support
            </a>
          }
        />
      </UnsubscribeShell>
    );
  }

  // ── 5. Success ─────────────────────────────────────────────────────────
  return (
    <UnsubscribeShell>
      <SuccessState email={email} />
    </UnsubscribeShell>
  );
}

// ---------------------------------------------------------------------------
// Layout wrapper
// ---------------------------------------------------------------------------

function UnsubscribeShell({ children }: { children: React.ReactNode }) {
  return <div className="unsub-outer">{children}</div>;
}

// ---------------------------------------------------------------------------
// State views
// ---------------------------------------------------------------------------

function SuccessState({ email }: { email: string }) {
  return (
    <div className="unsub-card">
      <div className="unsub-icon unsub-icon--success">
        <CheckIcon />
      </div>

      <div className="unsub-eyebrow">
        <span className="d" aria-hidden="true" />
        Unsubscribed
      </div>

      <h1 className="unsub-title">You&apos;re unsubscribed</h1>

      <p className="unsub-body">
        <strong>{email}</strong> has been removed from the UseMoney newsletter.
        You won&apos;t receive any more marketing emails from us.
      </p>

      <p className="unsub-body unsub-body--muted">
        Changed your mind? Resubscribe any time — we&apos;ll send you a fresh
        verification link.
      </p>

      <ResubscribeButton email={email} />

      <div className="unsub-footer-links">
        <Link href="/" className="unsub-link">
          Back to UseMoney
        </Link>
        <span className="unsub-sep" aria-hidden="true">
          ·
        </span>
        <SettingsLink />
      </div>
    </div>
  );
}

function AlreadyUnsubscribed({ email }: { email: string }) {
  return (
    <div className="unsub-card">
      <div className="unsub-icon unsub-icon--neutral">
        <InfoIcon />
      </div>

      <div className="unsub-eyebrow">
        <span className="d" aria-hidden="true" />
        Already removed
      </div>

      <h1 className="unsub-title">Already unsubscribed</h1>

      <p className="unsub-body">
        <strong>{email}</strong> is not subscribed to the UseMoney newsletter.
        No further action is needed.
      </p>

      <ResubscribeButton email={email} />

      <div className="unsub-footer-links">
        <Link href="/" className="unsub-link">
          Back to UseMoney
        </Link>
        <span className="unsub-sep" aria-hidden="true">
          ·
        </span>
        <SettingsLink />
      </div>
    </div>
  );
}

function ErrorState({
  icon,
  title,
  body,
  cta,
}: {
  icon: string;
  title: string;
  body: string;
  cta?: React.ReactNode;
}) {
  return (
    <div className="unsub-card">
      <div className="unsub-icon unsub-icon--error">
        <span aria-hidden="true">{icon}</span>
      </div>

      <div className="unsub-eyebrow">
        <span className="d" aria-hidden="true" />
        Error
      </div>

      <h1 className="unsub-title">{title}</h1>
      <p className="unsub-body">{body}</p>

      {cta && <div className="unsub-cta">{cta}</div>}

      <div className="unsub-footer-links">
        <Link href="/" className="unsub-link">
          Back to UseMoney
        </Link>
      </div>
    </div>
  );
}

function SettingsLink() {
  return (
    <Link href="/settings/notifications" className="unsub-link">
      Manage subscriptions in Settings
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

function CheckIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
