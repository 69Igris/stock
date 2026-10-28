"use client";

/**
 * TermsAcceptanceModal — playful re-skin (MONEY-484).
 *
 * Design source: TermsAcceptanceModal in screens-qa-essentials.jsx.
 * Visual: paper bg + 2px ink border + hard shadow; header with ink square
 * + gold scroll icon + serif intro; scrollable consent rows (each: emerald
 * checkbox, label + REQUIRED pill, description, "Read →"); footer with
 * "Decline & sign out" / "Accept all required".
 *
 * Functionality (acceptance persistence, server action, prefs, decline →
 * sign out) is unchanged. TermsGate still orchestrates this component.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Check, ScrollText } from "lucide-react";
import { acceptTermsAction } from "@/lib/actions/user";
import { clearCachedPlan } from "@/lib/subscription/plan-cache";

// ── Consent rows ──────────────────────────────────────────────────────────
interface ConsentRow {
  id: string;
  label: string;
  description: string;
  required: boolean;
  href: string | null;
  /** Hidden from the UI but kept in state (its consent default still applies). */
  hidden?: boolean;
}

const CONSENT_ROWS: ConsentRow[] = [
  {
    id: "terms",
    label: "Terms of service",
    description: "What we promise, what you promise.",
    required: true,
    href: "/terms",
  },
  {
    id: "privacy",
    label: "Privacy policy",
    description: "Data we store, where it lives (Mumbai), who can see it.",
    required: true,
    href: "/privacy",
  },
  {
    id: "data",
    label: "Data usage policy",
    description: "How broker data is synced, cached and protected.",
    required: true,
    href: "/data-usage",
  },
  {
    id: "risk",
    label: "SEBI risk disclosure",
    description:
      "Standard risk statement for Indian market investors. Not financial advice.",
    required: true,
    href: "/risk-disclosure",
  },
  {
    id: "analytics",
    label: "Usage analytics",
    description: "PostHog product analytics. No third-party ads ever.",
    required: false,
    href: null,
    hidden: true, // hidden for now — keep consent default (opt-in) without the UI row
  },
  {
    id: "marketing",
    label: "Marketing emails (optional)",
    description: "Newsletter every other Sunday · long reads on markets.",
    required: false,
    href: null,
  },
];

const REQUIRED_IDS = new Set(
  CONSENT_ROWS.filter((r) => r.required).map((r) => r.id)
);

// ── Component ─────────────────────────────────────────────────────────────
export default function TermsAcceptanceModal({
  onAccepted,
}: {
  onAccepted?: () => void;
}) {
  // Track which rows are accepted
  const initialAccepted: Record<string, boolean> = {};
  for (const row of CONSENT_ROWS) {
    initialAccepted[row.id] = !row.required; // optionals default on, required default off
  }
  const [accepted, setAccepted] =
    useState<Record<string, boolean>>(initialAccepted);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { signOut } = useClerk();

  const allRequiredAccepted = Array.from(REQUIRED_IDS).every(
    (id) => accepted[id]
  );

  const toggleRow = (id: string) => {
    setAccepted((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleAccept = () => {
    if (!allRequiredAccepted) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await acceptTermsAction({
          marketing: accepted.marketing ?? false,
          analytics: accepted.analytics ?? false,
        });
        if (result.success) {
          onAccepted?.();
          router.refresh();
        } else {
          setError(result.error ?? "Failed to accept terms. Please try again.");
        }
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const handleDecline = () => {
    // MONEY-1134 — declining terms signs the user out, so the persisted plan
    // must go with the session. Without this, `um_plan_v1` outlives it and the
    // next person on a shared browser hydrates this user's billing tier.
    clearCachedPlan();
    signOut({ redirectUrl: "/" });
  };

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="p-0 gap-0 [&>button]:hidden"
        style={{
          maxWidth: 620,
          width: "92%",
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "6px 6px 0 var(--ink)",
          color: "var(--ink)",
          // Keep shadcn's centering translate (left/top 50% + -50%,-50%) —
          // a bare rotate() here would replace it and drift the modal off-centre.
          // No panel-level rotate(): rotating a text-bearing panel forces
          // subpixel text re-rasterisation and renders the modal copy blurry.
          transform: "translate(-50%, -50%)",
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {/* ── Hidden accessible title / description ──────────────────── */}
        <DialogTitle className="sr-only">
          Accept Terms &amp; Policies
        </DialogTitle>
        <DialogDescription className="sr-only">
          Review and accept the required policies to continue using UseMoney.
        </DialogDescription>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div
          style={{
            padding: "16px 22px",
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {/* Icon square — ink bg + gold scroll icon */}
          <div
            aria-hidden
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: "var(--ink)",
              color: "var(--pop-2)",
              display: "grid",
              placeItems: "center",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            <ScrollText size={17} />
          </div>
          <div>
            <div
              style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.3px" }}
            >
              One last thing.
            </div>
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}
            >
              TERMS · PRIVACY · SEBI RISK DISCLOSURE
            </div>
          </div>
        </div>

        {/* ── Body ─────────────────────────────────────────────────────── */}
        <div style={{ padding: "20px 22px 0" }}>
          {/* Serif intro line */}
          <div
            className="ser"
            style={{
              fontSize: 16,
              color: "var(--ink-2)",
              lineHeight: 1.4,
              marginBottom: 16,
            }}
          >
            Read these once, agree, and we&apos;ll never ask again. We try to
            write them in plain English.
          </div>

          {/* Scrollable consent rows */}
          <div
            style={{
              maxHeight: 300,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              paddingRight: 4,
            }}
          >
            {CONSENT_ROWS.filter((row) => !row.hidden).map((row) => {
              const isAccepted = Boolean(accepted[row.id]);
              return (
                <label
                  key={row.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "12px 14px",
                    borderRadius: 9,
                    background: isAccepted
                      ? "var(--emerald-bg)"
                      : "var(--paper-2)",
                    border: `1.5px solid ${isAccepted ? "var(--emerald)" : "var(--rule-soft)"}`,
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                  }}
                >
                  {/* Emerald checkbox (purely visual — the wrapping <label>
                      drives the hidden <input>, so a separate onClick here would
                      double-toggle and cancel the click). */}
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 5,
                      border: "1.5px solid var(--ink)",
                      background: isAccepted
                        ? "var(--emerald)"
                        : "var(--paper)",
                      display: "grid",
                      placeItems: "center",
                      color: "var(--paper)",
                      flexShrink: 0,
                      marginTop: 1,
                      transition: "background 0.12s",
                      cursor: "pointer",
                    }}
                    aria-hidden
                  >
                    {isAccepted && <Check size={12} />}
                  </span>
                  <input
                    type="checkbox"
                    checked={isAccepted}
                    onChange={() => toggleRow(row.id)}
                    className="sr-only"
                    aria-label={row.label}
                  />

                  {/* Label + description */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 700 }}>
                        {row.label}
                      </span>
                      {row.required && (
                        <span
                          className="pf-pill"
                          style={{
                            background: "var(--pop-1)",
                            color: "var(--paper)",
                            borderColor: "var(--pop-1)",
                            fontSize: 9,
                          }}
                        >
                          REQUIRED
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        fontSize: 12,
                        color: "var(--ink-3)",
                        lineHeight: 1.35,
                      }}
                    >
                      {row.description}
                    </div>
                  </div>

                  {/* Read link */}
                  {row.href && (
                    <a
                      href={row.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: "var(--emerald-text)",
                        textDecoration: "underline",
                        alignSelf: "flex-start",
                        marginTop: 2,
                        flexShrink: 0,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Read →
                    </a>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        {/* ── Error ───────────────────────────────────────────────────── */}
        {error && (
          <div
            style={{
              margin: "12px 22px 0",
              padding: "10px 14px",
              borderRadius: 9,
              border: "1.5px solid rgba(185,28,28,0.4)",
              background: "rgba(185,28,28,0.08)",
              color: "var(--neg-text)",
              fontSize: 13,
            }}
          >
            <AlertTriangle
              size={13}
              style={{
                display: "inline",
                marginRight: 6,
                verticalAlign: "middle",
              }}
            />
            {error}
          </div>
        )}

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div
          style={{
            padding: "14px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            background: "var(--paper-2)",
            flexWrap: "wrap",
            marginTop: 16,
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 10.5, color: "var(--ink-3)" }}
          >
            You can change consent any time in Settings
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={handleDecline}
              disabled={isPending}
              className="pf-bf sm"
            >
              Decline &amp; sign out
            </button>
            <button
              type="button"
              onClick={handleAccept}
              disabled={!allRequiredAccepted || isPending}
              className="pf-bs sm"
              style={
                !allRequiredAccepted || isPending
                  ? { opacity: 0.5, cursor: "not-allowed" }
                  : undefined
              }
            >
              {isPending ? (
                "Accepting…"
              ) : (
                <>
                  Accept all required <Check size={11} />
                </>
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
