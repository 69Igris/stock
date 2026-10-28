/**
 * Marketing-route 404 (MONEY-483).
 *
 * This file sits inside app/(marketing)/ so Next.js wraps it automatically
 * with the marketing layout → PlayfulHeader + PlayfulFooter are already
 * present. We only need to render the 404 content block.
 *
 * NOT a client component — no Clerk hooks needed here because the marketing
 * layout is public-only. If the user happens to be signed in they'll still
 * see the correct public surface (they have the header's "Dashboard →" CTA).
 *
 * Design: NotFoundScreen from screens-qa-system.jsx — giant mono "404"
 * with serif-italic middle-zero + floating "oops" stamp, serif headline,
 * italic lede, Go back / Take me home CTAs.
 */

import Link from "next/link";

export const metadata = {
  title: "404 · Page not found — UseMoney AI",
};

export default function MarketingNotFound() {
  return (
    <main
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "80px 20px 100px",
        minHeight: "calc(100vh - 140px)",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 560, width: "100%" }}>
        {/* Giant 404 display number */}
        <div
          style={{
            position: "relative",
            display: "inline-block",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: "clamp(90px, 22vw, 180px)",
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
              color: "var(--pop-1-text)",
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
              right: "clamp(-48px, -10vw, -60px)",
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
        <h1
          style={{
            marginTop: 22,
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
        </h1>

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
            marginTop: 30,
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {/* pf-bf / pf-bs come from marketing playful.css via the layout */}
          <Link href="/" className="btn-flat">
            ← Go back
          </Link>
          <Link href="/home" className="btn-solid">
            Take me home
          </Link>
          <Link href="/sign-in" className="btn-flat">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
