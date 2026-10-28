"use client";

import { ShieldCheck, Check } from "lucide-react";

export type AuthKind = "in" | "up" | "verify" | "forgot";

const BROKERS: Array<{ n: string; slug: string }> = [
  { n: "Zerodha", slug: "zerodha" },
  { n: "Groww", slug: "groww" },
  { n: "Upstox", slug: "upstox" },
  { n: "Angel", slug: "angel" },
  { n: "Dhan", slug: "dhan" },
  { n: "Fyers", slug: "fyers" },
  { n: "HDFC Sky", slug: "hdfc" },
];

const FEATURES = [
  <>
    AI chat grounded in <strong>your</strong> holdings — cited, never made up
  </>,
  <>
    No-code <strong>strategy builder</strong> + walk-forward backtest
  </>,
  <>
    <strong>FIRE</strong> planning on real Indian tax rules
  </>,
  <>
    One reconciled <strong>XIRR</strong> across every broker
  </>,
];

function Quote({ kind }: { kind: AuthKind }) {
  if (kind === "up") {
    return (
      <>
        <span className="hl">Connect every broker.</span>
        <br />
        Ask StockSage. <span className="em">FIRE</span> on Indian numbers.
      </>
    );
  }
  if (kind === "verify") {
    return (
      <>
        One <span className="em">six-digit code</span> away from your{" "}
        <span className="hl">workspace.</span>
      </>
    );
  }
  if (kind === "forgot") {
    return (
      <>
        Forgot it? <span className="em">No drama.</span> We&apos;ll send a fresh
        link, <span className="hl">right away.</span>
      </>
    );
  }
  return (
    <>
      Five broker tabs and a <span className="hl">Google sheet</span> is{" "}
      <span className="em">not</span> how anyone should run a portfolio.
    </>
  );
}

/**
 * Right-hand brand panel for the auth split layout. Permanently deep-ink
 * regardless of theme (the colours below assume a dark background), so its
 * styles are hardcoded rather than token-based. Pure presentation.
 */
export default function AuthBrandPanel({ kind = "in" }: { kind?: AuthKind }) {
  return (
    <div className="auth-right">
      <div>
        <div className="auth-rp-brand">
          <span className="mk">U</span>
          <span className="nm">UseMoney AI</span>
        </div>

        <div className="auth-quote">
          <Quote kind={kind} />
        </div>
        <div className="auth-author">
          — FROM THE FOUNDING TEAM · <strong>UseMoney</strong>
        </div>

        <div className="auth-stats">
          <div className="s">
            <div className="l">USERS</div>
            <div className="v">12,840</div>
          </div>
          <div className="s">
            <div className="l">BROKERS</div>
            <div className="v">7</div>
          </div>
          <div className="s">
            <div className="l">TRADES SYNCED</div>
            <div className="v">4.2 M</div>
          </div>
          <div className="s">
            <div className="l">UPTIME · 90D</div>
            <div className="v">99.98%</div>
          </div>
        </div>

        <div className="auth-brokers-row">
          {BROKERS.map((b) => (
            <span key={b.slug} className="b">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/brokers/${b.slug}.png`} alt="" />
              {b.n}
            </span>
          ))}
        </div>

        <div className="auth-features">
          {FEATURES.map((f, i) => (
            <div className="ft" key={i}>
              <Check size={16} strokeWidth={2.5} />
              <span>{f}</span>
            </div>
          ))}
        </div>

        <div className="auth-stick">
          <strong>Read-only OAuth.</strong> We can <em>never</em> place orders.
        </div>
      </div>

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div className="auth-sec">
          <div className="ic">
            <ShieldCheck size={18} />
          </div>
          <div>
            <div className="t">SEBI-aligned · 256-bit AES-GCM</div>
            <div className="s">
              Mumbai-region data centre · MongoDB isolated per region
            </div>
          </div>
        </div>
        <div className="auth-rp-foot">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/risk-disclosure">SEBI risk</a>
          <span className="cp">© 2026 USEMONEY</span>
        </div>
      </div>
    </div>
  );
}
