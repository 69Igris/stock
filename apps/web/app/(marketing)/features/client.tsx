"use client";

import "./page.css";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";

export default function FeaturesClient() {
  const { isLoaded, isSignedIn } = useUser();

  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Features · three layers, one product
          </div>
          <h1>
            Three <span className="ser">layers.</span> One{" "}
            <span className="hl">product.</span>
          </h1>
          <p className="lede">
            The AI is the point. Multi-broker is the foundation. The screener
            and strategies are for when you want to go deeper.
          </p>
        </div>
      </section>

      <section className="section" style={{ padding: "48px 0 0" }}>
        <div className="container">
          {/* LAYER 01 — AI */}
          <div className="feat" id="sage">
            <div className="feat-layer-badge">01</div>
            <div className="feat-grid">
              <div className="feat-copy">
                <div className="group">01 / STOCKSAGE</div>
                <h3>
                  StockSage —{" "}
                  <span className="ser">AI that reads your portfolio.</span>
                </h3>
                <p className="lede">
                  Ask anything about a stock, a mutual fund, your holdings, or a
                  strategy. Answers reference your real tickers, real
                  quantities, real entry prices.
                </p>
                <ul>
                  <li>
                    <strong>Ask anything</strong> · stock analysis, fund
                    research, portfolio questions — in plain English
                  </li>
                  <li>
                    <strong>Grounded in your real data</strong> · knows your
                    HDFC Bank concentration, your Nifty 50 SIP cost, your INFY
                    entry price
                  </li>
                  <li>
                    <strong>Cited and auditable</strong> · every number links to
                    a source row — no hallucinated figures
                  </li>
                  <li>
                    <strong>Context-aware analysis</strong> · understands your
                    full book, not just the ticker you typed
                  </li>
                  <li>
                    <strong>Powered by Google Gemini via Vertex AI</strong> ·
                    your conversations are never used to train AI models
                  </li>
                </ul>
                <div className="chips">
                  <span className="tag-pill emerald">
                    free chat · all plans
                  </span>
                  <span className="tag-pill gold">deep research · credits</span>
                </div>
              </div>
              <div className="feat-art">
                <div className="surf-chrome">
                  <span className="lights">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="crumb">
                    usemoney.ai · <b>/sage</b> · concentration · HDFCBANK
                  </span>
                  <span className="live">live</span>
                </div>

                <div className="chat-surf">
                  {/* USER MESSAGE BUBBLE */}
                  <div className="chat-user">
                    <div className="bubble">
                      <div>
                        <span className="mention">@HDFCBANK</span>
                      </div>
                      my HDFC Bank is 32% of portfolio — is that too
                      concentrated?
                    </div>
                  </div>

                  {/* ASSISTANT BUBBLE */}
                  <div className="chat-asst">
                    <div className="chat-avatar" aria-hidden="true">
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#052e16"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m12 3-1.9 5.8a4 4 0 0 1-2.3 2.3L2 13l5.8 1.9a4 4 0 0 1 2.3 2.3L12 23l1.9-5.8a4 4 0 0 1 2.3-2.3L22 13l-5.8-1.9a4 4 0 0 1-2.3-2.3L12 3Z" />
                        <path d="M19 3v4M21 5h-4" />
                      </svg>
                    </div>

                    <div className="chat-asst-body">
                      <div className="chat-meta">
                        <span>
                          SAGE · L2 RESEARCH · CONCENTRATION · HDFCBANK
                        </span>
                        <span>02:48 PM</span>
                      </div>

                      <div className="card">
                        <p>
                          HDFC Bank at <b>32%</b> is{" "}
                          <b>2.4× the Nifty 50 weight</b> (13.2%). For most
                          retail books, that&apos;s in the concentrated band —
                          three things worth flagging:
                        </p>

                        {/* Embedded CardBlock (CardBlockRenderer) */}
                        <div className="cbcard">
                          <div className="cbcard-head">
                            <span>Concentration · HDFCBANK</span>
                            <span className="pill">Educational</span>
                          </div>
                          <div className="cbcard-value">32.4%</div>
                          <div className="cbcard-subtitle">
                            single-stock weight · 8 brokers reconciled
                          </div>
                          <div className="cbcard-items">
                            <div className="it">
                              <span className="lab">Nifty 50 wt</span>
                              <span className="val">13.2%</span>
                            </div>
                            <div className="it">
                              <span className="lab">Over-weight</span>
                              <span className="val warn">+19.2 pp</span>
                            </div>
                            <div className="it">
                              <span className="lab">Sector cap</span>
                              <span className="val warn">36% fin.</span>
                            </div>
                            <div className="it">
                              <span className="lab">Unrealised</span>
                              <span className="val pos">+₹14,300</span>
                            </div>
                            <div className="it">
                              <span className="lab">Avg cost</span>
                              <span className="val">₹1,520</span>
                            </div>
                            <div className="it">
                              <span className="lab">LTP</span>
                              <span className="val">₹1,743</span>
                            </div>
                          </div>
                        </div>

                        <div className="cite-rail">
                          <span className="em">SOURCES ›</span>
                          <span>Holdings sync · Zerodha</span>
                          <span className="dot" />
                          <span>NSE quotes · live</span>
                          <span className="dot" />
                          <span>updated 2m ago</span>
                        </div>
                      </div>

                      {/* Follow-up chips */}
                      <div className="fchips">
                        <span className="fchip">
                          <span className="arr">›</span> Show sector exposure
                        </span>
                        <span className="fchip">
                          <span className="arr">›</span> Compare to Nifty 50
                        </span>
                        <span className="fchip">
                          <span className="arr">›</span> Sell-down sim
                        </span>
                      </div>

                      {/* Action row */}
                      <div className="act-row">
                        <span>
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          Copy
                        </span>
                        <span>
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                            <polyline points="16 6 12 2 8 6" />
                            <line x1="12" y1="2" x2="12" y2="15" />
                          </svg>
                          Share
                        </span>
                        <span>
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="1 4 1 10 7 10" />
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                          </svg>
                          Regenerate
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* LAYER 02 — MULTI-BROKER */}
          <div className="feat rev" id="portfolio">
            <div className="feat-layer-badge">02</div>
            <div className="feat-grid">
              <div className="feat-art">
                <div className="surf-chrome">
                  <span className="lights">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="crumb">
                    usemoney.ai · <b>/holdings</b> · 8 brokers · read-only
                  </span>
                  <span className="live">synced</span>
                </div>

                <div className="hold-surf">
                  {/* Stat strip */}
                  <div className="hold-stats">
                    <div className="s">
                      <div className="lab">Total value</div>
                      <div className="val">₹15,42,180</div>
                      <div className="sub">8 brokers · 47 instr</div>
                    </div>
                    <div className="s">
                      <div className="lab">Day P/L</div>
                      <div className="val pos">+₹8,420</div>
                      <div className="sub pos">▲ 0.55%</div>
                    </div>
                    <div className="s">
                      <div className="lab">Total P/L</div>
                      <div className="val pos">+₹2,18,640</div>
                      <div className="sub pos">▲ 16.50%</div>
                    </div>
                    <div className="s">
                      <div className="lab">XIRR · all-time</div>
                      <div className="val">18.4%</div>
                      <div className="sub">FIFO · ITR-grade</div>
                    </div>
                  </div>

                  {/* Filter pills */}
                  <div className="hold-filters">
                    <span className="hold-pill on">All · 47</span>
                    <span className="hold-pill">Zerodha · 18</span>
                    <span className="hold-pill">Groww · 12</span>
                    <span className="hold-pill">Upstox · 9</span>
                    <span className="hold-pill">+5</span>
                  </div>

                  {/* Holding rows */}
                  <div className="hold-list">
                    <div className="hold-row">
                      <div className="left">
                        <div className="top-line">
                          <span className="sym">HDFCBANK</span>
                          <span className="sector">Financials</span>
                          <span className="brkchip">
                            <span
                              className="bav"
                              style={{ background: "#387ed1" }}
                            >
                              ZE
                            </span>
                            <span className="blab">ZERODHA · RK4392</span>
                          </span>
                        </div>
                        <div className="qarrow">
                          <span>
                            <span className="lab">QTY</span>
                            <span className="v">287</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">AVG</span>
                            <span className="v">₹1,520.00</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">LTP</span>
                            <span className="v ltp">₹1,743.00</span>
                          </span>
                        </div>
                      </div>
                      <div className="right">
                        <div className="pl pos">+₹64,001</div>
                        <div className="pct pos">▲ 14.67%</div>
                        <div className="val">
                          <span className="lab">INV</span> <b>₹4,36,240</b> ·{" "}
                          <span className="lab">CUR</span> <b>₹5,00,241</b>
                        </div>
                      </div>
                    </div>

                    <div className="hold-row">
                      <div className="left">
                        <div className="top-line">
                          <span className="sym">RELIANCE</span>
                          <span className="sector">Energy</span>
                          <span className="brkchip">
                            <span
                              className="bav"
                              style={{ background: "#5eb66e" }}
                            >
                              GR
                            </span>
                            <span className="blab">GROWW · AB1077</span>
                          </span>
                        </div>
                        <div className="qarrow">
                          <span>
                            <span className="lab">QTY</span>
                            <span className="v">94</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">AVG</span>
                            <span className="v">₹2,310.50</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">LTP</span>
                            <span className="v ltp">₹2,487.00</span>
                          </span>
                        </div>
                      </div>
                      <div className="right">
                        <div className="pl pos">+₹16,591</div>
                        <div className="pct pos">▲ 7.64%</div>
                        <div className="val">
                          <span className="lab">INV</span> <b>₹2,17,187</b> ·{" "}
                          <span className="lab">CUR</span> <b>₹2,33,778</b>
                        </div>
                      </div>
                    </div>

                    <div className="hold-row">
                      <div className="left">
                        <div className="top-line">
                          <span className="sym">INFY</span>
                          <span className="sector">IT</span>
                          <span className="brkchip">
                            <span
                              className="bav"
                              style={{ background: "#7b2ff7" }}
                            >
                              UP
                            </span>
                            <span className="blab">UPSTOX · ML8821</span>
                          </span>
                        </div>
                        <div className="qarrow">
                          <span>
                            <span className="lab">QTY</span>
                            <span className="v">120</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">AVG</span>
                            <span className="v">₹1,488.20</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">LTP</span>
                            <span className="v ltp">₹1,654.00</span>
                          </span>
                        </div>
                      </div>
                      <div className="right">
                        <div className="pl pos">+₹19,896</div>
                        <div className="pct pos">▲ 11.14%</div>
                        <div className="val">
                          <span className="lab">INV</span> <b>₹1,78,584</b> ·{" "}
                          <span className="lab">CUR</span> <b>₹1,98,480</b>
                        </div>
                      </div>
                    </div>

                    <div className="hold-row">
                      <div className="left">
                        <div className="top-line">
                          <span className="sym">TCS</span>
                          <span className="sector">IT</span>
                          <span className="brkchip">
                            <span
                              className="bav"
                              style={{ background: "#e85454" }}
                            >
                              AN
                            </span>
                            <span className="blab">ANGEL · C09431</span>
                          </span>
                        </div>
                        <div className="qarrow">
                          <span>
                            <span className="lab">QTY</span>
                            <span className="v">42</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">AVG</span>
                            <span className="v">₹3,907.00</span>
                          </span>
                          <span className="sep">·</span>
                          <span>
                            <span className="lab">LTP</span>
                            <span className="v ltp">₹3,821.00</span>
                          </span>
                        </div>
                      </div>
                      <div className="right">
                        <div className="pl neg">−₹3,612</div>
                        <div className="pct neg">▼ 2.20%</div>
                        <div className="val">
                          <span className="lab">INV</span> <b>₹1,64,094</b> ·{" "}
                          <span className="lab">CUR</span> <b>₹1,60,482</b>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Read-only footer */}
                  <div className="ro-foot">
                    <span className="em">READ-ONLY ·</span>
                    <span>
                      we cannot place, modify, or cancel orders — ever
                    </span>
                    <span className="dot" />
                    <span>disconnect any time</span>
                  </div>
                </div>
              </div>
              <div className="feat-copy">
                <div className="group">02 / UNIFIED LEDGER</div>
                <h3>
                  Every <span className="ser">broker,</span>{" "}
                  <span className="hl">one portfolio.</span>
                </h3>
                <p className="lede">
                  8 broker integrations — Zerodha, Groww, Angel One, Upstox,
                  Dhan, Fyers, HDFC Sky, and ICICI Direct (Beta). Holdings,
                  positions, and tradebook reconciled into a single ledger.
                </p>
                <ul>
                  <li>
                    <strong>8 brokers · live</strong> · Zerodha, Groww, Angel
                    One, Upstox, Dhan, Fyers, HDFC Sky, ICICI Direct (Beta)
                  </li>
                  <li>
                    <strong>NSE + BSE market data</strong> · real-time quotes,
                    historical data, 14,000+ mutual funds
                  </li>
                  <li>
                    <strong>Read-only OAuth</strong> · we cannot place, modify,
                    or cancel orders — ever
                  </li>
                  <li>
                    <strong>XIRR you can trust</strong> · FIFO-paired tradebook
                    across all connected brokers
                  </li>
                  <li>
                    <strong>Disconnect any time</strong> · your data leaves with
                    you, credentials wiped immediately
                  </li>
                </ul>
                <div className="chips">
                  <span className="tag-pill gold">8 brokers · live</span>
                  <span className="tag-pill blue">read-only · always</span>
                  <span className="tag-pill violet">14k+ mutual funds</span>
                </div>
              </div>
            </div>
          </div>

          {/* LAYER 03 — INSTITUTIONAL */}
          <div className="feat" id="power">
            <div className="feat-layer-badge">03</div>
            <div className="feat-grid">
              <div className="feat-copy">
                <div className="group">03 / POWER TIER</div>
                <h3>
                  Institutional-grade{" "}
                  <span className="ser">screening and strategies.</span>
                </h3>
                <p className="lede">
                  70+ technical and fundamental indicators. Walk-forward
                  backtesting that separates strategies that work from
                  strategies that overfit. INR-native FIRE planning. ITR-ready
                  capital-gains reports.
                </p>
                <ul>
                  <li>
                    <strong>70+ indicators</strong> · RSI, MACD, BB, EMA, ATR,
                    ADX, Stochastic, and 60+ more — stacked over PE, ROE,
                    debt/equity, FCF
                  </li>
                  <li>
                    <strong>No-code strategy builder</strong> · stack entry and
                    exit conditions without writing a line of code
                  </li>
                  <li>
                    <strong>Walk-forward backtesting</strong> · split train/test
                    windows; strategies that survive unseen data are different
                    from ones that don&apos;t
                  </li>
                  <li>
                    <strong>ITR-ready capital-gains report (FIFO)</strong> ·
                    STCG, LTCG, F&O, intraday — one statement across all
                    brokers, in the format your CA wants during ITR season
                  </li>
                  <li>
                    <strong>INR-native FIRE planner</strong> · EPF, PPF, NPS,
                    STCG/LTCG, new tax regime — not a US retirement calculator
                    reskinned
                  </li>
                </ul>
                <div className="chips">
                  <span className="tag-pill emerald">70+ indicators</span>
                  <span className="tag-pill pink">walk-forward backtest</span>
                  <span className="tag-pill gold">FIRE · INR-native</span>
                </div>
              </div>
              <div className="feat-art">
                <div className="surf-chrome">
                  <span className="lights">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="crumb">
                    usemoney.ai · <b>/strategies/nifty-momentum/backtest</b>
                  </span>
                  <span className="live">runner</span>
                </div>

                <div className="bt-surf">
                  {/* Backtest title row */}
                  <div className="bt-title">
                    <h4>
                      nifty_momentum <span className="ser">· walk-forward</span>
                    </h4>
                    <span className="alpha-pill">+2.7 pp alpha</span>
                    <span className="cap-flow">
                      ₹10,00,000 → <b>₹26,03,440</b>
                    </span>
                  </div>

                  {/* Dark 6-stat strip */}
                  <div className="bt-strip">
                    <div className="b">
                      <div className="lab">CAGR</div>
                      <div className="val pos">+14.7%</div>
                    </div>
                    <div className="b">
                      <div className="lab">SHARPE</div>
                      <div className="val">1.31</div>
                    </div>
                    <div className="b">
                      <div className="lab">MAX DD</div>
                      <div className="val neg">−18.4%</div>
                    </div>
                    <div className="b">
                      <div className="lab">1Y RTN</div>
                      <div className="val pos">+22.4%</div>
                    </div>
                    <div className="b">
                      <div className="lab">WIN RATE</div>
                      <div className="val">58.5%</div>
                    </div>
                    <div className="b">
                      <div className="lab">AVG HOLD</div>
                      <div className="val">37 d</div>
                    </div>
                  </div>

                  {/* Equity curve */}
                  <div className="bt-curve-card">
                    <div className="head">
                      <span className="ttl">
                        EQUITY · NIFTY_MOMENTUM vs NIFTY 500
                      </span>
                      <div className="leg">
                        <span className="strat">
                          <span className="swatch" />
                          strategy
                        </span>
                        <span className="bench">
                          <span
                            className="swatch"
                            style={{
                              background:
                                "repeating-linear-gradient(to right, var(--ink-4), var(--ink-4) 3px, transparent 3px, transparent 6px)",
                              height: "2.5px",
                            }}
                          />
                          nifty 500
                        </span>
                      </div>
                    </div>
                    <svg
                      viewBox="0 0 800 200"
                      preserveAspectRatio="none"
                      width="100%"
                      height="160"
                      aria-hidden="true"
                    >
                      <defs>
                        <linearGradient
                          id="curveGrad"
                          x1="0"
                          x2="0"
                          y1="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#16a34a"
                            stopOpacity="0.22"
                          />
                          <stop
                            offset="100%"
                            stopColor="#16a34a"
                            stopOpacity="0"
                          />
                        </linearGradient>
                        <pattern
                          id="gridPat"
                          width="80"
                          height="40"
                          patternUnits="userSpaceOnUse"
                        >
                          <path
                            d="M80 0H0V40"
                            fill="none"
                            stroke="rgba(29,29,27,0.06)"
                          />
                        </pattern>
                      </defs>
                      <rect width="800" height="200" fill="url(#gridPat)" />

                      {/* In-sample / out-of-sample divider */}
                      <line
                        x1="480"
                        y1="0"
                        x2="480"
                        y2="200"
                        stroke="rgba(167,139,250,0.5)"
                        strokeWidth="1"
                        strokeDasharray="3 4"
                      />
                      <text
                        x="60"
                        y="20"
                        fontFamily="JetBrains Mono"
                        fontSize="9"
                        fill="#7c3aed"
                        letterSpacing="1.2"
                      >
                        IN-SAMPLE · TRAIN
                      </text>
                      <text
                        x="490"
                        y="20"
                        fontFamily="JetBrains Mono"
                        fontSize="9"
                        fill="#7c3aed"
                        letterSpacing="1.2"
                      >
                        OUT-OF-SAMPLE · LIVE
                      </text>

                      {/* Benchmark (Nifty 500) */}
                      <path
                        d="M0,150 L80,148 L160,144 L240,142 L320,136 L400,132 L480,128 L560,122 L640,118 L720,114 L800,108"
                        fill="none"
                        stroke="#6b6b62"
                        strokeWidth="1.5"
                        strokeDasharray="4 4"
                      />

                      {/* Strategy equity curve */}
                      <path
                        d="M0,160 L80,154 L160,158 L240,142 L320,128 L400,114 L480,98 L560,88 L640,72 L720,52 L800,32 L800,200 L0,200 Z"
                        fill="url(#curveGrad)"
                      />
                      <path
                        d="M0,160 L80,154 L160,158 L240,142 L320,128 L400,114 L480,98 L560,88 L640,72 L720,52 L800,32"
                        fill="none"
                        stroke="#16a34a"
                        strokeWidth="2.2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />

                      {/* Split point marker */}
                      <circle
                        cx="480"
                        cy="98"
                        r="4"
                        fill="#16a34a"
                        stroke="var(--paper)"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>

                  {/* Walk-forward sensitivity callout */}
                  <div className="bt-callout">
                    <div className="ic">i</div>
                    <div className="body">
                      <span className="tag">
                        WALK-FORWARD · THE GAP THAT MATTERS
                      </span>
                      In-sample CAGR is <b>+22.1%</b>; out-of-sample is{" "}
                      <b>+14.7%</b> — a <span className="em">7.4 pp</span> gap.
                      Strategies that hold up on unseen NSE data are the ones
                      we&apos;ll show you. Most published backtests don&apos;t.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            Three <span className="ser">layers.</span>
            <br />
            One <span className="hl">product.</span>
          </h2>
          <p>Connect a broker in 60 seconds. Read-only. Free forever.</p>
          <div className="cta-row">
            <Link
              className="btn-solid"
              href={isLoaded && isSignedIn ? "/dashboard" : "/sign-up"}
            >
              {isLoaded && isSignedIn ? "Go to dashboard →" : "Start free →"}
            </Link>
            <Link className="btn-flat" href="/pricing">
              See pricing →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
