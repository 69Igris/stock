"use client";

import "./page.css";

import Link from "next/link";
import { useState } from "react";
import { useUser } from "@clerk/nextjs";

type BrokerStatus = "Live" | "Beta" | "Soon";

interface Broker {
  slug: string;
  name: string;
  status: BrokerStatus;
  scope: string;
  caps: string[];
  desc: string;
}

const BROKERS: Broker[] = [
  {
    slug: "zerodha",
    name: "Zerodha",
    status: "Beta",
    scope: "Beta · Holdings, positions, trades, mutual funds",
    caps: ["Holdings", "Positions", "Trades", "Mutual Funds"],
    desc: "India's largest discount broker. Full Kite Connect integration — reconciled tradebook, MF folios, and the data StockSage needs to answer questions about your real book.",
  },
  {
    slug: "groww",
    name: "Groww",
    status: "Soon",
    scope: "Coming soon ·Holdings, positions, trades, mutual funds",
    caps: ["Holdings", "Positions", "Trades", "Mutual Funds"],
    desc: "Groww Trade API. If your Nifty 50 SIP is here and your equity holdings are elsewhere, both feed the same unified ledger so XIRR is real.",
  },
  {
    slug: "angel",
    name: "Angel One",
    status: "Soon",
    scope: "Coming soon ·Holdings, positions, trades, mutual funds",
    caps: ["Holdings", "Positions", "Trades", "Mutual Funds"],
    desc: "SmartAPI integration. Full holdings, F&O positions, and tradebook history — including settled contracts — reconcile across your other connected brokers.",
  },
  {
    slug: "upstox",
    name: "Upstox",
    status: "Soon",
    scope: "Coming soon ·Holdings, positions, trades",
    caps: ["Holdings", "Positions", "Trades"],
    desc: "Upstox Developer API v2. Holdings, positions, and tradebook history. Live tick stream wired for real-time portfolio valuation.",
  },
  {
    slug: "dhan",
    name: "Dhan",
    status: "Soon",
    scope: "Coming soon ·Holdings, positions, trades",
    caps: ["Holdings", "Positions", "Trades"],
    desc: "Dhan API. Equity and F&O positions reconcile into the unified ledger. Tradebook history feeds the FIFO-paired capital-gains report.",
  },
  {
    slug: "fyers",
    name: "Fyers",
    status: "Soon",
    scope: "Coming soon ·Holdings, positions, trades",
    caps: ["Holdings", "Positions", "Trades"],
    desc: "Fyers v3 API. Holdings, positions, and tradebook. Historical OHLCV flows into Scanner and walk-forward backtesting.",
  },
  {
    slug: "hdfc",
    name: "HDFC Sky",
    status: "Soon",
    scope: "Coming soon ·Holdings, positions",
    caps: ["Holdings", "Positions"],
    desc: "HDFC Securities' platform. Holdings and positions feed the unified ledger. If you hold large HDFC Bank positions here, StockSage can read them alongside your other brokers.",
  },
  {
    slug: "icici",
    name: "ICICI Direct",
    status: "Soon",
    scope: "Coming soon · Holdings, positions",
    caps: ["Holdings", "Positions"],
    desc: "Breeze Connect integration, coming soon. Holdings and positions will sync into the ledger; full tradebook and MF support follows in a subsequent release.",
  },
];

// Capability matrix — 7 brokers (ICICI excluded as it is Coming Soon).
// Zerodha is the only Beta integration shipping today; the other six
// (Groww, Angel One, Upstox, Dhan, Fyers, HDFC Sky) are labeled Coming
// Soon while we stage their production rollout. The matrix is a forward
// view of what each connection covers when it lands.
// Column order: Zerodha, Groww, Angel, Upstox, Dhan, Fyers, HDFC Sky.
const MATRIX_ROWS: Array<[string, Array<boolean>]> = [
  ["Holdings sync", [true, true, true, true, true, true, true]],
  ["Positions (F&O / intraday)", [true, true, true, true, true, true, true]],
  ["Tradebook history", [true, true, true, true, true, true, true]],
  ["Mutual fund folios", [true, false, false, false, false, false, true]],
  ["Live tick stream", [true, false, true, true, false, false, false]],
  ["Tax report (auto)", [true, true, true, true, true, true, true]],
];

type FormState = "idle" | "submitting" | "submitted" | "error";

export default function IntegrationsClient() {
  // Broker-request form state — wired to POST /api/broker-request which
  // emails founder@usemoney.ai and adds the visitor to the newsletter audience.
  const [email, setEmail] = useState("");
  const [brokerName, setBrokerName] = useState("");
  const [formState, setFormState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { isLoaded, isSignedIn } = useUser();

  async function handleRequestBroker(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (formState === "submitting") return;

    setFormState("submitting");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/broker-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, brokerName }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;

      if (!res.ok) {
        setFormState("error");
        setErrorMsg(data?.error || "Something went wrong. Please try again.");
        return;
      }

      setFormState("submitted");
      setEmail("");
      setBrokerName("");
    } catch {
      setFormState("error");
      setErrorMsg("Network issue. Please try again.");
    }
  }

  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Integrations · 1 beta · 7 coming soon
          </div>
          <h1>
            Every broker, <span className="ser">in one</span>{" "}
            <span className="hl">ledger.</span>
          </h1>
          <p className="lede">
            OAuth into eight of India&apos;s largest brokers. Holdings,
            positions, and tradebook reconcile across accounts so you finally
            see your real XIRR.{" "}
            <b>Read-only — we cannot place, modify, or cancel orders.</b>
          </p>
        </div>
      </section>

      {/* 01 — BROKER GRID */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">01 / BROKERS</span>
            <h2>
              Eight brokers, <span className="ser">one unified ledger.</span>
            </h2>
          </div>
          <p className="section-sub">
            All via official broker OAuth. Read-only. We cannot place orders.
            Disconnect any broker any time — credentials are removed
            immediately.
          </p>

          <div className="b-grid" style={{ marginTop: 36 }}>
            {BROKERS.map((b) => (
              <div className="b-card" key={b.slug}>
                <div className="b-logo">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/brokers/${b.slug}.png`} alt={b.name} />
                </div>
                <div className="b-body">
                  <div className="name">{b.name}</div>
                  <div className="url">{b.scope}</div>
                  <p>{b.desc}</p>
                  <div className="caps">
                    {b.caps.map((c) => (
                      <span className="tag-pill" key={c}>
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
                <span
                  className={`b-status ${
                    b.status === "Beta"
                      ? "beta"
                      : b.status === "Soon"
                        ? "soon"
                        : ""
                  }`}
                >
                  {b.status === "Soon" ? "Coming Soon" : b.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 02 — WHAT SYNCS */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">02 / WHAT SYNCS</span>
            <h2>
              What syncs, <span className="ser">per broker.</span>
            </h2>
          </div>
          <p className="section-sub">
            All brokers use read-only OAuth. Beyond holdings, this is
            what&apos;s available.
          </p>

          <div style={{ overflowX: "auto", marginTop: 30 }}>
            <table className="matrix">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Zerodha</th>
                  <th>Groww</th>
                  <th>Angel</th>
                  <th>Upstox</th>
                  <th>Dhan</th>
                  <th>Fyers</th>
                  <th>HDFC Sky</th>
                </tr>
              </thead>
              <tbody>
                {MATRIX_ROWS.map(([cap, values]) => (
                  <tr key={cap}>
                    <td>{cap}</td>
                    {values.map((v, i) => (
                      <td key={i} className={v ? "ok" : "no"}>
                        {v ? "✓" : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 03 — SECURITY MINI-BLOCK */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">03 / SECURITY</span>
            <h2>
              How we handle <span className="ser">your credentials.</span>
            </h2>
          </div>
          <p className="section-sub">
            The short version. Full details are on{" "}
            <Link
              href="/security"
              style={{ color: "var(--emerald-text)", textDecoration: "underline" }}
            >
              /security
            </Link>
            .
          </p>

          <div className="security-grid" style={{ marginTop: 36 }}>
            <div className="sec-card">
              <div className="sec-icon">🔒</div>
              <h4>AES-256-GCM at rest</h4>
              <p>
                OAuth access tokens are encrypted with AES-256-GCM before
                storage. Per-user encryption keys — one compromised user does
                not expose others.
              </p>
            </div>
            <div className="sec-card">
              <div className="sec-icon">🔑</div>
              <h4>No password storage</h4>
              <p>
                We use OAuth — we never see your broker login password. Access
                tokens only. TLS 1.2+ in transit on every API call.
              </p>
            </div>
            <div className="sec-card">
              <div className="sec-icon">👁</div>
              <h4>Read-only, by design</h4>
              <p>
                Our OAuth scopes request read permission only. We cannot place,
                modify, or cancel orders on any broker — even if you asked us
                to.
              </p>
            </div>
            <div className="sec-card">
              <div className="sec-icon">🗑</div>
              <h4>Disconnect → wiped</h4>
              <p>
                Disconnect any broker and the encrypted access token is deleted
                immediately. Your data leaves with you.
              </p>
            </div>
          </div>

          <p
            style={{
              marginTop: 20,
              fontSize: 14,
              color: "var(--ink-3)",
              fontFamily: "'Instrument Serif', serif",
              fontStyle: "italic",
            }}
          >
            <Link
              href="/security"
              style={{ color: "var(--emerald-text)", textDecoration: "underline" }}
            >
              Read the full /security details →
            </Link>
          </p>
        </div>
      </section>

      {/* 04 — CONNECT */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">04 / CONNECT</span>
            <h2>
              Sixty seconds, <span className="ser">three steps.</span>
            </h2>
          </div>

          <div className="setup-grid" style={{ marginTop: 36 }}>
            <div className="step-card">
              <span className="n">STEP 01</span>
              <h4>
                Pick your <span className="ser">broker.</span>
              </h4>
              <p>
                Tap the broker icon in your UseMoney workspace. You&apos;ll be
                redirected to the broker&apos;s official login page.
              </p>
              <code className="code-block" style={{ marginTop: 14 }}>
                <span className="emerald">→</span> select · zerodha
                <br />
                <span className="emerald">→</span> redirect · kite.zerodha.com
                <br />
                <span className="emerald">→</span> oauth · read-only scope
              </code>
            </div>
            <div className="step-card">
              <span className="n">STEP 02</span>
              <h4>
                Approve <span className="ser">read-only.</span>
              </h4>
              <p>
                Log in on the broker&apos;s site, approve the read-only scope.
                We never see your credentials. Tokens are encrypted before
                storage.
              </p>
              <code className="code-block" style={{ marginTop: 14 }}>
                <span className="emerald">→</span> auth · OK
                <br />
                <span className="emerald">→</span> token · encrypted · AES-256
                <br />
                <span className="emerald">→</span> scope · read-only · confirmed
              </code>
            </div>
            <div className="step-card">
              <span className="n">STEP 03</span>
              <h4>
                StockSage reads <span className="ser">your real money.</span>
              </h4>
              <p>
                Holdings sync first, then positions, then tradebook —
                FIFO-paired into a unified XIRR. StockSage can now answer
                questions about your actual book.
              </p>
              <code className="code-block" style={{ marginTop: 14 }}>
                <span className="emerald">→</span> sync · holdings · 47 instr
                <br />
                <span className="emerald">→</span> sync · positions · 3
                <br />
                <span className="emerald">→</span> sync · tradebook · 2,114 rows
                <br />
                <span className="emerald">→</span> stocksage · ready
              </code>
            </div>
          </div>

          <div className="twocol" style={{ marginTop: 36 }}>
            <div className="info-box">
              <h4>
                Broker not on the list? <span className="ser">CSV import.</span>
              </h4>
              <p>
                For any unsupported broker, drop your statement CSV and
                we&apos;ll reconcile it into the unified ledger. Auto-detect for
                14+ broker formats — same tax report, same XIRR.
              </p>
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span className="tag-pill emerald">CSV / XLSX</span>
                <span className="tag-pill gold">14+ formats</span>
                <span className="tag-pill blue">same tax report</span>
              </div>
            </div>
            <div className="info-box">
              <h4>
                Request a <span className="ser">broker.</span>
              </h4>
              <p>
                We prioritise broker integrations by user demand. Tell us yours
                and we&apos;ll mark you for early access when it goes live.
              </p>
              {formState === "submitted" ? (
                <div
                  style={{
                    marginTop: 14,
                    color: "var(--emerald-text)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                  }}
                >
                  ✓ added to the waitlist. We will email you.
                </div>
              ) : (
                <form onSubmit={handleRequestBroker}>
                  <input
                    type="email"
                    placeholder="you@email.com"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={formState === "submitting"}
                  />
                  <input
                    type="text"
                    placeholder="broker name"
                    required
                    style={{ maxWidth: 140 }}
                    value={brokerName}
                    onChange={(e) => setBrokerName(e.target.value)}
                    disabled={formState === "submitting"}
                  />
                  <button
                    className="btn-solid"
                    type="submit"
                    disabled={formState === "submitting"}
                  >
                    {formState === "submitting" ? "Sending…" : "Notify"}
                  </button>
                </form>
              )}
              {formState === "error" && errorMsg ? (
                <div
                  style={{
                    marginTop: 10,
                    color: "var(--pop-1-text)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                  }}
                >
                  {errorMsg}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            Connect <span className="hl">your</span>{" "}
            <span className="hl">first</span> broker.
          </h2>
          <p>
            Read-only. Sixty seconds. We can&apos;t place orders even if we
            wanted to.
          </p>
          <div className="cta-row">
            <Link
              className="btn-solid"
              href={isLoaded && isSignedIn ? "/dashboard" : "/sign-up"}
            >
              {isLoaded && isSignedIn ? "Go to dashboard →" : "Start free →"}
            </Link>
            <Link className="btn-flat" href="/security">
              How we keep tokens safe
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
