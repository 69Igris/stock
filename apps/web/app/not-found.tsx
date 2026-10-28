"use client";

/**
 * Root 404 — auth vs public split (MONEY-483 / MONEY-485).
 *
 * Signed-in  → app shell (Sidebar + offset main) with a large playful 404
 *              display number, serif headline, and "Back to dashboard" CTA.
 * Signed-out → standalone pf-app surface (no app chrome, no user data).
 *              Marketing routes (marketing)/ and (public)/ each have their
 *              own not-found.tsx that sits inside the PlayfulHeader layout;
 *              this root variant is the fallback for anything else.
 *
 * Design: NotFoundScreen from screens-qa-system.jsx — giant mono "404"
 * with serif-italic middle zero + floating "oops" stamp, serif headline,
 * italic lede, Go back / Take me home / Ask Sage CTAs.
 */

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { ArrowLeft, Home, Sparkles } from "lucide-react";
import Sidebar from "@/components/Sidebar";

// ── Shared 404 content block ──────────────────────────────────────────────
function NotFoundContent({ signedIn }: { signedIn: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
        minHeight: signedIn ? "calc(100vh - 56px)" : "100vh",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 560, width: "100%" }}>
        {/* Giant 404 display number */}
        <div
          style={{
            position: "relative",
            display: "inline-block",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "clamp(100px, 22vw, 180px)",
            fontWeight: 800,
            letterSpacing: -8,
            lineHeight: 0.9,
            color: "var(--ink)",
            userSelect: "none",
          }}
        >
          4
          <span
            style={{
              color: "var(--pop-1)",
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontWeight: 400,
            }}
          >
            0
          </span>
          4{/* Floating "oops" stamp */}
          <span
            style={{
              position: "absolute",
              top: "50%",
              right: "clamp(-52px, -10vw, -60px)",
              transform: "translateY(-50%) rotate(8deg)",
              padding: "6px 12px",
              background: "var(--pop-2)",
              border: "2px solid var(--ink)",
              borderRadius: 10,
              boxShadow: "3px 3px 0 var(--ink)",
              fontFamily: "Instrument Serif, serif",
              fontSize: 16,
              fontStyle: "italic",
              color: "#1d1d1b",
              whiteSpace: "nowrap",
            }}
          >
            <strong
              style={{
                fontFamily: "Inter, system-ui, sans-serif",
                fontStyle: "normal",
              }}
            >
              oops
            </strong>
          </span>
        </div>

        {/* Headline */}
        <h2
          style={{
            marginTop: 20,
            fontSize: "clamp(26px, 6vw, 36px)",
            fontWeight: 800,
            letterSpacing: "-1.4px",
            lineHeight: 1.1,
            color: "var(--ink)",
          }}
        >
          This page{" "}
          <span
            style={{
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontWeight: 400,
            }}
          >
            doesn&apos;t exist.
          </span>
        </h2>

        {/* Lede */}
        <p
          style={{
            marginTop: 14,
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
            fontSize: 17,
            color: "var(--ink-3)",
            lineHeight: 1.45,
            maxWidth: 440,
            margin: "14px auto 0",
          }}
        >
          Either we broke a link, or the URL got mistyped. Either way, the
          markets are still open.
        </p>

        {/* CTAs */}
        <div
          style={{
            marginTop: 28,
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="pf-bf"
            onClick={() => {
              if (typeof window !== "undefined") window.history.back();
            }}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <ArrowLeft size={13} />
            Go back
          </button>

          <Link
            href={signedIn ? "/dashboard" : "/"}
            className="pf-bs"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Home size={13} />
            {signedIn ? "Back to dashboard" : "Take me home"}
          </Link>

          {signedIn && (
            <Link
              href="/dashboard"
              className="pf-bf"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Sparkles size={13} color="var(--emerald)" />
              Ask StockSage instead
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page component ────────────────────────────────────────────────────────
export default function NotFound() {
  const { isSignedIn } = useUser();

  // Signed-in → preserve the app shell (Sidebar) so navigation stays familiar.
  if (isSignedIn) {
    return (
      <div className="pf-app" style={{ minHeight: "100vh" }}>
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <NotFoundContent signedIn />
        </main>
      </div>
    );
  }

  // Signed-out → standalone pf-app surface, no app chrome, no user data.
  // Marketing / public routes have their own not-found.tsx with the full
  // PlayfulHeader; this is the fallback for everything else.
  return (
    <div className="pf-app" style={{ minHeight: "100vh" }}>
      <NotFoundContent signedIn={false} />
    </div>
  );
}
