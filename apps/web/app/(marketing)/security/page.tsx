import "./page.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title:
    "Security — UseMoney AI · Read-only OAuth, AES-256-GCM, made in India.",
  description:
    "How UseMoney protects your data: read-only broker OAuth, AES-256-GCM at rest with per-user keys, TLS 1.2+ in transit, MongoDB Atlas, Google Cloud, never used to train AI models.",
};

export default function SecurityPage() {
  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Security at UseMoney
          </div>
          <h1>
            We never <span className="strike">place trades.</span>{" "}
            <span className="ser">
              And we built the rest of the security posture to match.
            </span>
          </h1>
          <p className="lede">
            Read-only broker OAuth. AES-256-GCM per-user encryption. TLS 1.2+ in
            transit. <b>Your data is never used to train AI models.</b>
          </p>
        </div>
      </section>

      {/* ── BLOCK 1: BROKER ACCESS ── */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">01 / BROKER ACCESS</span>
            <h2>
              Read-only. <span className="ser">Always.</span>
            </h2>
          </div>
          <p className="section-sub">
            Every broker connection goes through official OAuth. We never see
            your password. We literally cannot place an order.
          </p>

          <div className="pillars" style={{ marginTop: 36 }}>
            <div className="pillar">
              <div className="ic">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h4>
                Official OAuth, <span className="ser">eight brokers.</span>
              </h4>
              <p>
                Zerodha Kite Connect, Upstox API, Angel One SmartAPI, Groww API,
                Dhan API, Fyers API, HDFC Sky, ICICI Direct. No scrapers, no
                screen automation — only official broker APIs.
              </p>
              <div className="meta">OAuth · read-only scope</div>
            </div>
            <div className="pillar">
              <div className="ic">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <h4>
                No passwords <span className="ser">stored. Ever.</span>
              </h4>
              <p>
                We store only the OAuth access token, encrypted. Your broker
                password never enters UseMoney servers — you log in on the
                broker&apos;s own site and we receive a scoped token.
              </p>
              <div className="meta">Token · AES-256 encrypted</div>
            </div>
            <div className="pillar">
              <div className="ic">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.9" y1="4.9" x2="19.1" y2="19.1" />
                </svg>
              </div>
              <h4>
                Cannot place orders, <span className="ser">by design.</span>
              </h4>
              <p>
                The order-placement API scope is never requested. We can only
                read: holdings, positions, tradebook, MF folios. Nothing else —
                the broker enforces this, not just our promise.
              </p>
              <div className="meta">Scope-restricted · broker-enforced</div>
            </div>
          </div>

          <div className="promise-list">
            <div className="lbl">What this means in practice</div>
            <ul>
              <li>
                <strong>
                  Your password never leaves the broker&apos;s site.
                </strong>{" "}
                You log in on Kite, Groww, HDFC Sky — we are never in that loop.
              </li>
              <li>
                <strong>We can only read data the scope allows:</strong>{" "}
                holdings, positions, tradebook, MF folios, corporate actions.
                Nothing else.
              </li>
              <li>
                <strong>We cannot place, modify, or cancel orders.</strong> The
                order-placement scope is never requested.
              </li>
              <li>
                <strong>Disconnect any time.</strong> One click in our app, or
                directly in the broker&apos;s portal. Credentials are removed
                within seconds.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── BLOCK 2: ENCRYPTION & INFRA ── */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">02 / FLOW</span>
            <h2>
              How a broker connection{" "}
              <span className="ser">actually works.</span>
            </h2>
          </div>
          <p className="section-sub">
            The end-to-end OAuth flow, simplified. The broker holds your
            credentials. We never see them.
          </p>

          <div className="diagram" style={{ marginTop: 36 }}>
            <div className="lbl">
              broker → usemoney · read-only scope · token encrypted at rest
            </div>
            <div className="flow">
              <div className="node">
                <div className="t">YOU</div>
                <div className="b">Browser</div>
                <div className="s">never enters password into UseMoney</div>
              </div>
              <div className="arr">
                <div className="a">→</div>
                <div className="l">redirect</div>
              </div>
              <div className="node">
                <div className="t">BROKER</div>
                <div className="b">e.g. Kite</div>
                <div className="s">login + scope approval</div>
              </div>
              <div className="arr">
                <div className="a">→</div>
                <div className="l">read-only token</div>
              </div>
              <div className="node um">
                <div className="t">USEMONEY</div>
                <div className="b">Encrypted vault</div>
                <div className="s">AES-256-GCM · per-user key</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── BLOCK 3: SPECIFICS ── */}
      <section className="section">
        <div className="container-narrow">
          <div className="section-h">
            <span className="num">03 / DETAILS</span>
            <h2>
              The <span className="hl">specifics,</span> by layer.
            </h2>
          </div>

          <div className="detail">
            <div className="label">Encryption</div>
            <div className="body">
              <h3>
                AES-256-GCM, <span className="ser">per-user keys.</span>
              </h3>
              <p>
                All sensitive data — broker tokens, contract notes, documents —
                is encrypted at rest with <strong>AES-256-GCM</strong>.
                Encryption keys are per-user, so one compromised key cannot
                decrypt another user&apos;s data.
              </p>
              <p>
                In transit: <strong>TLS 1.2+</strong> everywhere. HSTS enforced.
              </p>
            </div>
          </div>

          <div className="detail">
            <div className="label">Infrastructure</div>
            <div className="body">
              <h3>
                MongoDB Atlas ·{" "}
                <span className="ser">Google Cloud · Vercel.</span>
              </h3>
              <p>
                Portfolio data stored in <strong>MongoDB Atlas</strong>{" "}
                (encryption at rest + TLS in transit). Hosted on{" "}
                <strong>Google Cloud Platform (us-central1)</strong> and{" "}
                <strong>Vercel</strong>. Market-data cache in Redis with short
                TTLs (quotes 5 min, historical 1 hr).
              </p>
              <p>
                Authentication via <strong>Clerk</strong> — supports OAuth
                social login and MFA.
              </p>
            </div>
          </div>

          <div className="detail">
            <div className="label">What we do NOT do</div>
            <div className="body">
              <h3>
                Three hard <span className="ser">nos.</span>
              </h3>
              <ul>
                <li>
                  <strong>We never sell your data.</strong> Not to brokers, not
                  to advertisers, not to data aggregators.
                </li>
                <li>
                  <strong>We never place trades on your behalf.</strong>{" "}
                  UseMoney is read-only.
                </li>
                <li>
                  <strong>
                    We never use your portfolio data or chat history to train AI
                    models.
                  </strong>{" "}
                  Your data is yours.
                </li>
                <li>
                  <strong>
                    We never share identifiable data with other users.
                  </strong>
                </li>
              </ul>
            </div>
          </div>

          <div className="detail">
            <div className="label">AI engine</div>
            <div className="body">
              <h3>
                Google Gemini via <span className="ser">Vertex AI.</span>
              </h3>
              <p>
                The production AI engine is <strong>Google Gemini</strong>,
                accessed via <strong>Google Vertex AI (us-central1)</strong>.
                When you chat with StockSage, anonymised portfolio context
                (symbol + quantity, never your name, email, or broker
                credentials) is sent to Gemini for the response.
              </p>
              <p>
                Chat history is stored so you can refer back. It is never used
                for training. It can be deleted any time from the chat history
                page.
              </p>
            </div>
          </div>

          <div className="detail">
            <div className="label">Data deletion</div>
            <div className="body">
              <h3>
                Your data, <span className="ser">your control.</span>
              </h3>
              <ul>
                <li>Account deletion removes all your data within 30 days.</li>
                <li>
                  Disconnecting a broker removes its credentials immediately.
                </li>
                <li>
                  Individual AI chats can be deleted from the chat history any
                  time.
                </li>
              </ul>
              <p>
                Full subprocessor list:{" "}
                <Link href="/subprocessors">/subprocessors</Link>.
              </p>
            </div>
          </div>

          <div className="detail">
            <div className="label">Compliance</div>
            <div className="body">
              <h3>
                Pre-RIA. <span className="ser">Honest about it.</span>
              </h3>
              <p>
                We are pre-RIA — SEBI Investment Adviser registration is in
                motion. We will publish certifications as they are earned. We do
                not (yet) hold SOC 2 or ISO 27001; we will not claim either
                until we do.
              </p>
            </div>
          </div>

          <div className="disclose">
            <h4>
              Reporting a <span className="ser">security issue.</span>
            </h4>
            <p>
              If you believe you&apos;ve found a vulnerability in UseMoney,
              email <code>security@usemoney.ai</code>. Include reproduction
              steps. We respond within 48 hours and will keep you updated
              through remediation.
            </p>
            <div className="row">
              <span>
                <b>↳</b> security@usemoney.ai
              </span>
              <span>
                <b>↳</b> 48-hour response commitment
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            Security <span className="hl">by architecture,</span>
            <br />
            not <span className="ser">by promise.</span>
          </h2>
          <p>
            Read-only OAuth means we don&apos;t have the capability to place
            orders. By design.
          </p>
          <div className="cta-row">
            <Link className="btn-solid" href="/integrations">
              Connect a broker safely →
            </Link>
            <Link className="btn-flat" href="/risk-disclosure">
              Risk disclosure →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
