"use client";

/**
 * Global error boundary — catastrophic, layout-level crash (MONEY-483).
 *
 * Triggered when an error escapes app/layout.tsx itself. At this point even
 * ClerkProvider is unavailable, so this file MUST be fully self-contained:
 * it renders its own <html>/<body>, has NO imports from the app, and carries
 * every colour / font inline. Playful design is hardcoded so the page is safe
 * even when playful-app.css fails to load.
 *
 * Light theme  → cream #f7f3e6 / ink #1d1d1b (matches --paper / --ink)
 * Dark variant → uses prefers-color-scheme media query inside the CSS so
 *                there is no JS / next-themes dependency here.
 *
 * For non-catastrophic errors inside a route, see app/error.tsx which
 * preserves the full app shell.
 */

import { useEffect } from "react";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Fully-hardcoded inline CSS that works without any stylesheet loaded.
// Static string — no user data interpolated, safe to embed directly.
const CRITICAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@700;800&family=Inter:wght@600;700;800&display=swap');

  :root {
    --ge-bg:     #f7f3e6;
    --ge-bg2:    #efe7d0;
    --ge-ink:    #1d1d1b;
    --ge-ink2:   #3a3a35;
    --ge-ink3:   #6b6b62;
    --ge-rule:   rgba(29,29,27,.14);
    --ge-rulem:  rgba(29,29,27,.08);
    --ge-em:     #16a34a;
    --ge-shadow: 4px 4px 0 #1d1d1b;
    --ge-dot:    rgba(29,29,27,.045);
    --ge-dot2:   rgba(29,29,27,.03);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ge-bg:    #16140e;
      --ge-bg2:   #1f1c14;
      --ge-ink:   #f4ede0;
      --ge-ink2:  #d8d1c4;
      --ge-ink3:  #a09a8d;
      --ge-rule:  rgba(244,237,224,.16);
      --ge-rulem: rgba(244,237,224,.08);
      --ge-em:    #34d399;
      --ge-shadow: 4px 4px 0 #000;
      --ge-dot:   rgba(244,237,224,.05);
      --ge-dot2:  rgba(244,237,224,.035);
    }
  }

  html, body { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--ge-bg);
    background-image:
      radial-gradient(var(--ge-dot)  1px, transparent 1.5px),
      radial-gradient(var(--ge-dot2) 1px, transparent 1.5px);
    background-size: 7px 7px, 11px 11px;
    background-position: 0 0, 3px 3px;
    color: var(--ge-ink);
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 28px 20px;
  }

  .ge-icon {
    width: 90px; height: 90px;
    border-radius: 22px;
    background: #b91c1c;
    color: #f7f3e6;
    display: grid; place-items: center;
    border: 3px solid var(--ge-ink);
    transform: rotate(-3deg);
    box-shadow: var(--ge-shadow);
    margin: 0 auto;
  }
  .ge-icon svg { width: 42px; height: 42px; stroke: #f7f3e6; fill: none; }

  .ge-eyebrow {
    margin-top: 20px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; font-weight: 700;
    letter-spacing: 1.5px; text-transform: uppercase;
    color: #b91c1c;
  }

  .ge-h1 {
    margin: 10px 0 0;
    font-size: clamp(26px, 6vw, 34px);
    font-weight: 800;
    letter-spacing: -1.4px;
    line-height: 1.05;
    color: var(--ge-ink);
  }
  .ge-h1 em {
    font-family: 'Instrument Serif', 'Times New Roman', serif;
    font-style: italic; font-weight: 400;
  }

  .ge-lede {
    margin: 14px auto 0;
    font-family: 'Instrument Serif', 'Times New Roman', serif;
    font-style: italic; font-size: 16px;
    color: var(--ge-ink3); line-height: 1.45;
    max-width: 440px;
  }

  .ge-chip {
    display: inline-block;
    margin-top: 18px;
    padding: 8px 14px;
    background: var(--ge-rulem);
    border: 1.5px dashed var(--ge-rule);
    border-radius: 9px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11.5px; color: var(--ge-ink3);
  }
  .ge-chip strong { color: var(--ge-ink); }

  .ge-row {
    margin-top: 24px;
    display: flex; gap: 10px;
    justify-content: center; flex-wrap: wrap;
  }

  .ge-btn-s {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 9px 16px; border-radius: 8px;
    background: var(--ge-em);
    color: #1d1d1b; font-size: 13.5px; font-weight: 700;
    border: 2px solid var(--ge-ink);
    box-shadow: 3px 3px 0 var(--ge-ink);
    cursor: pointer; text-decoration: none;
    transition: transform .12s, box-shadow .12s;
  }
  .ge-btn-s:hover {
    transform: translate(1px, 1px);
    box-shadow: 2px 2px 0 var(--ge-ink);
  }

  .ge-btn-f {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 9px 16px; border-radius: 8px;
    background: var(--ge-bg);
    color: var(--ge-ink); font-size: 13.5px; font-weight: 700;
    border: 2px solid var(--ge-ink);
    box-shadow: 3px 3px 0 var(--ge-ink);
    cursor: pointer; text-decoration: none;
    transition: transform .12s, box-shadow .12s;
  }
  .ge-btn-f:hover {
    transform: translate(1px, 1px);
    box-shadow: 2px 2px 0 var(--ge-ink);
  }
`;

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // Last-ditch breadcrumb — Datadog should have caught this, but log anyway.
    console.error("[global-error.tsx]", error);

    // MONEY-726 — "Datadog should have caught this" was FALSE for this
    // boundary, and that is the whole reason for the code below. `global-error`
    // replaces the document when `app/layout.tsx` itself throws, so it renders
    // ABOVE the tree that mounts DatadogRumProvider: RUM was never initialised
    // in this render, there is no buffer to drain into, and the single most
    // severe client failure we can have has been reaching nothing but the
    // browser console. So this boundary initialises RUM itself.
    //
    // Both imports are dynamic and each chain carries its own `.catch`, which
    // is what keeps this file's self-contained promise: a chunk that fails to
    // load degrades to the console line above. An unhandled rejection here
    // fires inside the crash page — the one place a second failure has nothing
    // left to catch it.
    //
    // rum-init loads FIRST, deliberately: with no NEXT_PUBLIC_DD_* pair (local
    // dev, previews) there is nowhere to send anything, and this ordering means
    // the crash page never fetches the ~100 kB RUM bundle it cannot use.
    import("@/lib/datadog/rum-init")
      .then(({ rumInitConfig }) => {
        const cfg = rumInitConfig();
        if (!cfg) return;
        return import("@datadog/browser-rum")
          .then(({ datadogRum }) => {
            // Guarded because `reset()` re-runs this effect, and a second
            // `init()` is refused with a console error of its own — noise
            // inside the very surface we are trying to read.
            if (!datadogRum.getInitConfiguration()) datadogRum.init(cfg);
            datadogRum.addError(error, {
              digest: error?.digest,
              boundary: "global-error",
            });
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }, [error]);

  return (
    <html lang="en">
      <head>
        {/*
         * Inline <style> via JSX — no user data, fully static.
         * Avoids dangerouslySetInnerHTML while keeping the CSS self-contained
         * so this page works even when the main CSS bundle never loaded.
         */}
        <style>{CRITICAL_CSS}</style>
      </head>
      <body>
        <div style={{ textAlign: "center", maxWidth: 580, width: "100%" }}>
          {/* Icon box: AlertTriangle rendered inline so no lucide import needed */}
          <div className="ge-icon">
            <svg
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m10.29 3.86-8.45 14.6A2 2 0 0 0 3.62 21h16.76a2 2 0 0 0 1.72-3l-8.44-14.6a2 2 0 0 0-3.37.46Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          {/* Eyebrow */}
          <div className="ge-eyebrow">
            ● ERROR 500 · APPLICATION FAILED TO LOAD
          </div>

          {/* Headline */}
          <h1 className="ge-h1">
            UseMoney couldn&apos;t <em>start up.</em>
          </h1>

          {/* Lede */}
          <p className="ge-lede">
            Refresh to try again. If this keeps happening, email{" "}
            <strong style={{ fontStyle: "normal" }}>support@usemoney.ai</strong>{" "}
            with the error ID below — our team will look into it.
          </p>

          {/* Digest chip */}
          {error?.digest && (
            <div className="ge-chip">
              Request ID: <strong>{error.digest}</strong>
            </div>
          )}

          {/* CTAs */}
          <div className="ge-row">
            <button type="button" className="ge-btn-s" onClick={() => reset()}>
              {/* RefreshCw inline SVG */}
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 2v6h-6" />
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
              Try again
            </button>

            <a href="/" className="ge-btn-f">
              {/* Home inline SVG */}
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
