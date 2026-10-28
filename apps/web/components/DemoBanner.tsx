"use client";

import Link from "next/link";
import { Eye, X } from "lucide-react";
import { useState } from "react";
import "@/components/banners/banners.css";

/**
 * DemoBanner — playful re-skin (MONEY-484).
 *
 * Full-width strip with 2px ink bottom border, rotated blue icon square,
 * serif accent in copy, outline + solid action buttons, dismiss X.
 * Design source: .pf-banner.demo (screens-qa-essentials.jsx).
 * All colours come from playful tokens — theme-aware via html.dark.
 * Behaviour (dismiss, sign-in CTA) is unchanged.
 */
export function DemoBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="pf-banner demo" role="banner" aria-label="Demo mode notice">
      {/* Rotated icon square */}
      <div className="ic" aria-hidden>
        <Eye size={15} />
      </div>

      {/* Copy */}
      <div className="body">
        <div className="t">
          You&apos;re in <span className="ser">demo mode.</span>
        </div>
        <div className="s">
          Showing sample portfolio. Holdings, P&amp;L and Sage chats are fake.{" "}
          <Link
            href="/sign-in"
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            Sign in
          </Link>{" "}
          to use your real data.
        </div>
      </div>

      {/* Actions */}
      <div className="actions">
        <Link href="/sign-up" className="btn-bn solid">
          <span>Sign up free →</span>
        </Link>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        className="x"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss demo banner"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * DemoGate - wraps interactive elements, showing a CTA overlay in demo mode.
 */
export function DemoGate({
  isDemoMode,
  message = "Sign up to use this feature",
  children,
}: {
  isDemoMode: boolean;
  message?: string;
  children: React.ReactNode;
}) {
  if (!isDemoMode) return <>{children}</>;

  return (
    <div className="relative">
      <div className="opacity-50 pointer-events-none">{children}</div>
      <div
        className="absolute inset-0 flex items-center justify-center rounded-lg backdrop-blur-[1px]"
        style={{
          background: "color-mix(in srgb, var(--paper) 65%, transparent)",
        }}
      >
        <div className="text-center">
          <p
            style={{
              marginBottom: 10,
              fontFamily: "'Instrument Serif', serif",
              fontStyle: "italic",
              fontSize: 15,
              color: "var(--ink-2)",
            }}
          >
            {message}
          </p>
          <Link href="/sign-up" className="pf-bs sm">
            Sign up free
          </Link>
        </div>
      </div>
    </div>
  );
}
