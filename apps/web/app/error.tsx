"use client";

/**
 * Root error boundary (the Next.js 500 surface) — auth vs public split
 * (MONEY-483 / MONEY-485). Signed-in users get it inside the app shell;
 * signed-out visitors get a standalone playful surface with no app chrome
 * and no user data. Preserves reset() retry + digest logging.
 *
 * Design: ErrorScreen from screens-qa-system.jsx — large alert icon box
 * (coral/red, hard shadow, tilted), mono "● ERROR 500" eyebrow, serif
 * headline, italic lede, request-id chip, Try again + Tell us CTAs.
 */

import { useEffect } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { AlertTriangle, RefreshCw, MessageSquare } from "lucide-react";
import Sidebar from "@/components/Sidebar";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// ── Shared error content block ────────────────────────────────────────────
function ErrorContent({
  signedIn,
  digest,
  reset,
}: {
  signedIn: boolean;
  digest?: string;
  reset: () => void;
}) {
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
      <div style={{ textAlign: "center", maxWidth: 580, width: "100%" }}>
        {/* Alert icon box — coral, tilted, hard shadow */}
        <div
          style={{
            width: 90,
            height: 90,
            borderRadius: 22,
            background: "#b91c1c",
            // Constant red box needs a constant-cream glyph — var(--paper)
            // flipped to deep-ink in dark mode (invisible on the red).
            color: "#f7f3e6",
            display: "grid",
            placeItems: "center",
            border: "3px solid var(--ink)",
            transform: "rotate(-3deg)",
            boxShadow: "5px 5px 0 var(--ink)",
            margin: "0 auto",
          }}
        >
          <AlertTriangle size={42} />
        </div>

        {/* Eyebrow */}
        <div
          className="mono"
          style={{
            marginTop: 20,
            fontSize: 11,
            color: "var(--neg-text)",
            letterSpacing: 1.5,
            fontWeight: 700,
          }}
        >
          ● ERROR 500 · SOMETHING BROKE ON OUR END
        </div>

        {/* Headline */}
        <h2
          style={{
            marginTop: 10,
            fontSize: "clamp(26px, 6vw, 36px)",
            fontWeight: 800,
            letterSpacing: "-1.4px",
            lineHeight: 1.05,
            color: "var(--ink)",
          }}
        >
          Markets break too,{" "}
          <span
            style={{
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontWeight: 400,
            }}
          >
            but rarely
          </span>{" "}
          like this.
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
            maxWidth: 460,
            margin: "14px auto 0",
          }}
        >
          Our team got pinged. While they fix it, your holdings &amp; tradebook
          are safe — nothing&apos;s lost.
        </p>

        {/* Request / error ID chip */}
        {digest && (
          <div
            style={{
              marginTop: 20,
              padding: "10px 16px",
              background: "var(--rule-softer)",
              border: "1.5px dashed var(--ink)",
              borderRadius: 10,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11.5,
              color: "var(--ink-3)",
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span>
              Request ID:{" "}
              <strong style={{ color: "var(--ink)" }}>{digest}</strong>
            </span>
          </div>
        )}

        {/* CTAs */}
        <div
          style={{
            marginTop: 22,
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="pf-bf"
            onClick={() => reset()}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <RefreshCw size={13} />
            Try again
          </button>

          <Link
            href={signedIn ? "/dashboard" : "/"}
            className="pf-bs"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <MessageSquare size={13} />
            {signedIn ? "Tell us what happened" : "Go home"}
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Page component ────────────────────────────────────────────────────────
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  const { isSignedIn } = useUser();

  useEffect(() => {
    if (error?.digest) {
      console.error(`[error.tsx] digest=${error.digest}`, error);
    } else {
      console.error("[error.tsx]", error);
    }

    // MONEY-726 — report the boundary hit to RUM EXPLICITLY. RUM's automatic
    // error collection sees uncaught exceptions and console.error, but a React
    // error boundary is precisely the case where React has already CAUGHT the
    // throw: what arrives is a re-render of this component, not an uncaught
    // error, so without this call the most severe client failure we have is
    // the one Datadog does not have a first-class event for. The `digest` is
    // the only join key back to the server-side stack Next.js logged.
    //
    // Ordering against DatadogRumProvider does not matter. Verified in
    // @datadog/browser-rum 6.26.0: node_modules/@datadog/browser-rum-core/cjs/
    // boot/preStartRum.js:165-167 implements the pre-init `addError` as
    // `bufferApiCalls.add(startRumResult => startRumResult.addError(...))`,
    // and :43 `bufferApiCalls.drain(startRumResult)` replays that buffer the
    // moment `init()` runs. The context object rides along — the public API
    // (rumPublicApi.js:96-107) folds `error` and `context` into ONE argument
    // before the buffer sees it, so the `boundary` tag survives the replay.
    import("@datadog/browser-rum")
      .then(({ datadogRum }) =>
        datadogRum.addError(error, { digest: error?.digest, boundary: "error" })
      )
      // A monitoring provider must never be able to break the app: an
      // uncaught chunk-load rejection here would fire INSIDE the error page,
      // which is the one place a second failure has nothing left to catch it.
      .catch(() => undefined);
  }, [error]);

  if (isSignedIn) {
    return (
      <div className="pf-app" style={{ minHeight: "100vh" }}>
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <ErrorContent signedIn digest={error?.digest} reset={reset} />
        </main>
      </div>
    );
  }

  return (
    <div className="pf-app" style={{ minHeight: "100vh" }}>
      <ErrorContent signedIn={false} digest={error?.digest} reset={reset} />
    </div>
  );
}
