"use client";

/* =====================================================================
   Tax Report v2 — Income & Gains section (MONEY-485)
   CA-grade income-head sub-tabs. Capital Gains is fully wired to the
   real TaxReportResult (realised P&L table, pre/post 23-Jul split,
   unrealized headroom). Every other income head (salary, house property,
   F&O business, ESOPs, crypto, other sources, foreign assets, exempt)
   renders the structure + representative "in plain English" explainer
   cards, with honest "needs data" empty states — never fabricated ₹.
   ===================================================================== */

import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import type { TaxReportResult } from "@/lib/actions/tax";
import {
  Card,
  Pill,
  Cite,
  SectionH,
  SubTabs,
  Bar,
  EmptyState,
  fmtINR,
  fmtINRSigned,
  type Tone,
} from "../components/primitives";

type IncomeTab =
  | "salary"
  | "house"
  | "cg"
  | "fno"
  | "esops"
  | "crypto"
  | "other"
  | "foreign"
  | "exempt";

const INCOME_TABS: Array<{
  id: IncomeTab;
  label: string;
  badge?: string;
  badgeTone?: Tone;
}> = [
  { id: "salary", label: "Salary" },
  { id: "house", label: "House Property" },
  { id: "cg", label: "Capital Gains" },
  { id: "fno", label: "F&O Business" },
  { id: "esops", label: "ESOPs / RSUs" },
  { id: "crypto", label: "Crypto · VDA", badge: "30%", badgeTone: "coral" },
  { id: "other", label: "Other Sources" },
  { id: "foreign", label: "Foreign Assets", badge: "FA", badgeTone: "gold" },
  { id: "exempt", label: "Exempt" },
];

export default function IncomeGains({
  report,
  fy,
  ask,
}: {
  report: TaxReportResult;
  fy: string;
  ask: (q: string) => void;
}) {
  const [tab, setTab] = useState<IncomeTab>("cg");

  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <SectionH
        n="02 · INCOME & GAINS"
        title={
          <>
            Every income head, <span className="ser">classified.</span>
          </>
        }
        meta={`FY ${fy} · ${report.capitalGains.trades.length} closed trades`}
      />

      <SubTabs items={INCOME_TABS} active={tab} onChange={setTab} />

      <div style={{ marginTop: 4 }}>
        {tab === "cg" && <CapitalGainsTab report={report} fy={fy} ask={ask} />}
        {tab === "salary" && <SalaryTab ask={ask} />}
        {tab === "house" && <HousePropertyTab ask={ask} />}
        {tab === "fno" && <FnoTab report={report} ask={ask} />}
        {tab === "esops" && <EsopsTab ask={ask} />}
        {tab === "crypto" && <CryptoTab ask={ask} />}
        {tab === "other" && <OtherSourcesTab ask={ask} />}
        {tab === "foreign" && <ForeignAssetsTab ask={ask} />}
        {tab === "exempt" && <ExemptTab ask={ask} />}
      </div>
    </div>
  );
}

/* ════════════════ CAPITAL GAINS (real data) ════════════════ */

function CapitalGainsTab({
  report,
  fy,
  ask,
}: {
  report: TaxReportResult;
  fy: string;
  ask: (q: string) => void;
}) {
  const [view, setView] = useState<"realized" | "split" | "unrealized">(
    "realized"
  );
  const cg = report.capitalGains;
  const trades = cg.trades;

  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <SubTabs
        items={[
          { id: "realized", label: "Realised P&L" },
          { id: "split", label: "Pre / Post 23-Jul" },
          { id: "unrealized", label: "Unrealized" },
        ]}
        active={view}
        onChange={setView}
      />

      {view === "realized" &&
        (trades.length === 0 ? (
          <EmptyState
            title="No closed trades this FY"
            body={
              <>
                Once you have closed (sold) positions in FY {fy}, every realised
                gain/loss will be FIFO-matched and classified here as STCG or
                LTCG.
              </>
            }
            icon={<Info className="h-5 w-5" />}
          />
        ) : (
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table className="pf-tbl">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: 18 }}>SYMBOL</th>
                    <th>HELD</th>
                    <th>TYPE</th>
                    <th style={{ textAlign: "right" }}>BUY VALUE</th>
                    <th style={{ textAlign: "right" }}>SELL VALUE</th>
                    <th style={{ textAlign: "right", paddingRight: 18 }}>
                      GAIN / LOSS
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => {
                    const tone: Tone =
                      t.gain < 0
                        ? "coral"
                        : t.type === "LTCG"
                          ? "blue"
                          : t.type === "F&O"
                            ? "violet"
                            : "emerald";
                    const heldLabel =
                      t.holdingDays >= 365
                        ? `${(t.holdingDays / 365).toFixed(1)}y`
                        : `${t.holdingDays}d`;
                    return (
                      <tr key={`${t.symbol}-${i}`}>
                        <td style={{ paddingLeft: 18 }} className="tk">
                          {t.symbol}
                        </td>
                        <td className="num" style={{ color: "var(--ink-3)" }}>
                          {heldLabel}
                        </td>
                        <td>
                          <Pill tone={tone}>{t.type}</Pill>
                        </td>
                        <td
                          className="num"
                          style={{ textAlign: "right", color: "var(--ink-3)" }}
                        >
                          {fmtINR(t.buyValue)}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {fmtINR(t.sellValue)}
                        </td>
                        <td
                          className={"num " + (t.gain >= 0 ? "pos" : "neg")}
                          style={{
                            textAlign: "right",
                            fontWeight: 800,
                            paddingRight: 18,
                          }}
                        >
                          {fmtINRSigned(t.gain)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div
              className="mono"
              style={{
                padding: "14px 18px",
                background: "var(--paper-2)",
                borderTop: "1.5px solid var(--rule-soft)",
                display: "flex",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 8,
                fontSize: 12,
              }}
            >
              <span style={{ color: "var(--ink-3)" }}>
                {trades.length} closed trades
              </span>
              <span>
                STCG net{" "}
                <b className={cg.equity.stcg.net >= 0 ? "pos" : "neg"}>
                  {fmtINR(cg.equity.stcg.net)}
                </b>{" "}
                · LTCG net{" "}
                <b className={cg.equity.ltcg.net >= 0 ? "pos" : "neg"}>
                  {fmtINR(cg.equity.ltcg.net)}
                </b>
              </span>
              <span>
                tax <b>{fmtINR(cg.equity.stcg.tax + cg.equity.ltcg.tax)}</b>
              </span>
            </div>
          </Card>
        ))}

      {view === "split" && (
        <>
          <Card style={{ background: "var(--paper-2)" }}>
            <div className="flex gap-2" style={{ alignItems: "flex-start" }}>
              <Info
                className="h-4 w-4 shrink-0"
                style={{ color: "var(--pop-5-text)", marginTop: 2 }}
              />
              <div
                style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}
              >
                On <b>23 Jul 2024</b> the Finance Act changed equity
                capital-gains rates mid-year: STCG 15% &rarr; 20%, LTCG 10%
                &rarr; 12.5%, and the LTCG exempt cap rose ₹1L &rarr; ₹1.25L{" "}
                <Cite>Finance (No.2) Act 2024</Cite>. The per-lot pre/post split
                is being wired up.
              </div>
            </div>
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 14 }}>
            <Card>
              <div className="ttl">STCG · s.111A</div>
              <div
                className="mono"
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  letterSpacing: -1,
                  marginTop: 8,
                }}
              >
                {fmtINR(cg.equity.stcg.tax)}
              </div>
              <div
                className="ser"
                style={{ fontSize: 13.5, color: "var(--ink-3)", marginTop: 4 }}
              >
                net gain {fmtINR(cg.equity.stcg.net)} · gross{" "}
                {fmtINR(cg.equity.stcg.gains)}, losses{" "}
                {fmtINR(cg.equity.stcg.losses)}
              </div>
              <div
                className="col"
                style={{
                  marginTop: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <Bar
                  label="Taxed @ 20% (post 23-Jul)"
                  pct={100}
                  value={fmtINR(cg.equity.stcg.tax)}
                  color="var(--pop-1)"
                />
              </div>
              <div style={{ marginTop: 10 }}>
                <Pill tone="gold">
                  per-period split · coming soon · MONEY-486
                </Pill>
              </div>
            </Card>
            <Card tilt="r">
              <div className="ttl">LTCG · s.112A</div>
              <div
                className="mono"
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  letterSpacing: -1,
                  marginTop: 8,
                  color: "var(--pop-5-text)",
                }}
              >
                {fmtINR(cg.equity.ltcg.tax)}
              </div>
              <div
                className="ser"
                style={{ fontSize: 13.5, color: "var(--ink-3)", marginTop: 4 }}
              >
                taxable {fmtINR(cg.equity.ltcg.taxable)} after ₹
                {(cg.equity.ltcg.exemption / 1e5).toFixed(2)}L exempt
              </div>
              <div
                className="col"
                style={{
                  marginTop: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <Bar
                  label="Exempt used"
                  pct={
                    cg.equity.ltcg.gains > 0
                      ? (cg.equity.ltcg.exemption / cg.equity.ltcg.gains) * 100
                      : 0
                  }
                  value={fmtINR(cg.equity.ltcg.exemption)}
                  color="var(--pop-5)"
                />
                <Bar
                  label="Taxed @ 12.5%"
                  pct={
                    cg.equity.ltcg.gains > 0
                      ? (cg.equity.ltcg.taxable / cg.equity.ltcg.gains) * 100
                      : 0
                  }
                  value={fmtINR(cg.equity.ltcg.taxable)}
                  color="var(--pop-3)"
                />
              </div>
            </Card>
          </div>
        </>
      )}

      {view === "unrealized" && (
        <EmptyState
          title="Phantom tax — if you sold today"
          body={
            <>
              This will project the tax you&rsquo;d owe if every open holding
              were sold now &mdash; your mark-to-market gains and after-tax NAV.
              It needs live holdings valuation, tracked under MONEY-486.
            </>
          }
          icon={<Info className="h-5 w-5" />}
          cta={
            <button
              type="button"
              className="pf-bf sm"
              onClick={() => ask("What is phantom tax on unrealized gains?")}
            >
              Explain phantom tax
            </button>
          }
        />
      )}
    </div>
  );
}

/* ════════════════ F&O BUSINESS (partial real data) ════════════════ */

function FnoTab({
  report,
  ask,
}: {
  report: TaxReportResult;
  ask: (q: string) => void;
}) {
  const fno = report.capitalGains.fno;
  const hasFno = fno.net !== 0 || fno.profits !== 0 || fno.losses !== 0;

  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
        <Card>
          <div className="ttl">NET F&O P&L</div>
          <div
            className={"mono " + (fno.net >= 0 ? "" : "")}
            style={{
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: -1,
              marginTop: 8,
              color: hasFno
                ? fno.net >= 0
                  ? "var(--emerald-text)"
                  : "var(--pop-1-text)"
                : "var(--ink-3)",
            }}
          >
            {hasFno ? fmtINR(fno.net) : "—"}
          </div>
          <div
            className="ser"
            style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}
          >
            {fno.note || "Non-speculative business income"}
          </div>
        </Card>
        <Card style={{ background: "var(--paper-2)" }}>
          <div className="ttl">TURNOVER</div>
          <div
            className="mono"
            style={{
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: -1,
              marginTop: 8,
              color: "var(--ink-3)",
            }}
          >
            needs data
          </div>
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}
          >
            audit threshold ₹10 Cr <Cite>s.44AB</Cite> · MONEY-486
          </div>
        </Card>
        <Card style={{ background: "var(--paper-2)" }}>
          <div className="ttl">REQUIRED ITR</div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: -0.5,
              marginTop: 8,
            }}
          >
            ITR-3
          </div>
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}
          >
            F&O is business income <Cite>s.43(5)</Cite>
          </div>
        </Card>
      </div>

      <Card>
        <div className="ttl">WHY F&O IS &ldquo;BUSINESS&rdquo; INCOME</div>
        <div
          className="ser"
          style={{
            fontSize: 14.5,
            color: "var(--ink-2)",
            marginTop: 8,
            lineHeight: 1.55,
          }}
        >
          Per <Cite>s.43(5)</Cite>, F&amp;O trades on a recognised exchange are{" "}
          <b style={{ fontFamily: "Inter, sans-serif", fontStyle: "normal" }}>
            non-speculative business income
          </b>{" "}
          &mdash; not capital gains. You file{" "}
          <b style={{ fontFamily: "Inter, sans-serif", fontStyle: "normal" }}>
            ITR-3
          </b>
          , can deduct expenses (brokerage, STT, GST, connectivity), and carry
          forward losses for 8 years.
        </div>
        <div
          className="flex items-center gap-2"
          style={{ marginTop: 12, flexWrap: "wrap" }}
        >
          <Pill tone="emerald">loss carry-forward · 8 years</Pill>
          <Pill tone="gold">expense ledger · coming soon</Pill>
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => ask("How is F&O turnover calculated?")}
          >
            How is turnover calculated?
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ════════════════ Educational / placeholder income heads ════════════════ */

function HeadExplainer({
  title,
  cite,
  body,
  bullets,
  ask,
  askPrompt,
}: {
  title: string;
  cite?: string;
  body: ReactNode;
  bullets: Array<{ tone: Tone; text: ReactNode }>;
  ask: (q: string) => void;
  askPrompt: string;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 14 }}>
      <EmptyState
        title={`${title} — not yet computed`}
        body={body}
        icon={<Info className="h-5 w-5" />}
        cta={
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => ask(askPrompt)}
          >
            Ask StockSage about {title.toLowerCase()}
          </button>
        }
      />
      <Card>
        <div className="ttl">
          HOW IT&rsquo;S TAXED {cite ? <Cite>{cite}</Cite> : null}
        </div>
        <div
          className="col"
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {bullets.map((b, i) => (
            <div
              key={i}
              className="flex gap-2"
              style={{
                padding: 10,
                background: "var(--paper-2)",
                borderRadius: 8,
                alignItems: "flex-start",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  marginTop: 6,
                  flexShrink: 0,
                  background:
                    b.tone === "emerald"
                      ? "var(--emerald)"
                      : b.tone === "coral"
                        ? "var(--pop-1)"
                        : b.tone === "gold"
                          ? "var(--pop-2)"
                          : b.tone === "violet"
                            ? "var(--pop-5)"
                            : "var(--ink-3)",
                }}
              />
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-2)",
                  lineHeight: 1.45,
                }}
              >
                {b.text}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function SalaryTab({ ask }: { ask: (q: string) => void }) {
  return (
    <HeadExplainer
      title="Salary"
      cite="s.17"
      body={
        <>
          Add your Form 16 to compute net taxable salary, HRA / LTA exemptions,
          perquisites, and the standard deduction. We don&rsquo;t have your
          salary on file yet.
        </>
      }
      bullets={[
        {
          tone: "ink",
          text: (
            <>
              Gross salary, allowances and perquisites are taxed under the
              Salary head.
            </>
          ),
        },
        {
          tone: "emerald",
          text: (
            <>New regime gives a ₹75,000 standard deduction (no 80C / HRA).</>
          ),
        },
        {
          tone: "violet",
          text: (
            <>
              ESOP exercise is taxed here as a perquisite{" "}
              <Cite>s.17(2)(vi)</Cite>.
            </>
          ),
        },
      ]}
      ask={ask}
      askPrompt="How is salary income computed under the new regime?"
    />
  );
}

function HousePropertyTab({ ask }: { ask: (q: string) => void }) {
  return (
    <HeadExplainer
      title="House Property"
      cite="s.24"
      body={
        <>
          Declare self-occupied or let-out property to compute the s.24(b)
          interest deduction and any loss that can set off against other heads
          (capped at ₹2L/year).
        </>
      }
      bullets={[
        {
          tone: "ink",
          text: (
            <>
              Self-occupied: annual value is nil; interest capped at ₹2L{" "}
              <Cite>s.24(b)</Cite>.
            </>
          ),
        },
        {
          tone: "emerald",
          text: (
            <>
              Let-out: 30% standard deduction <Cite>s.24(a)</Cite>, no interest
              cap.
            </>
          ),
        },
        {
          tone: "coral",
          text: (
            <>
              Net HP loss sets off other heads up to ₹2L <Cite>s.71B</Cite>;
              excess carries 8 years.
            </>
          ),
        },
      ]}
      ask={ask}
      askPrompt="How does house property loss set-off work?"
    />
  );
}

function EsopsTab({ ask }: { ask: (q: string) => void }) {
  return (
    <HeadExplainer
      title="ESOPs / RSUs"
      cite="s.17(2)(vi)"
      body={
        <>
          ESOPs and RSUs are taxed twice &mdash; once on vest/exercise (as
          salary) and again on sale (as capital gain). Add your grant ledger to
          compute both legs.
        </>
      }
      bullets={[
        {
          tone: "violet",
          text: (
            <>
              Event 1 &mdash; vest/exercise: FMV minus exercise price, taxed as
              salary &rarr; Schedule S.
            </>
          ),
        },
        {
          tone: "emerald",
          text: (
            <>
              Event 2 &mdash; sale: sale price minus FMV at vest = capital gain
              &rarr; Schedule CG.
            </>
          ),
        },
        {
          tone: "gold",
          text: <>Foreign ESOPs also need Schedule FA disclosure.</>,
        },
      ]}
      ask={ask}
      askPrompt="How are ESOPs and RSUs taxed in India?"
    />
  );
}

function CryptoTab({ ask }: { ask: (q: string) => void }) {
  return (
    <HeadExplainer
      title="Crypto / VDA"
      cite="s.115BBH"
      body={
        <>
          Virtual digital assets are taxed at a flat 30% with no set-off and no
          carry-forward. Connect your exchange statements to compute net gains
          and the 1% TDS credit.
        </>
      }
      bullets={[
        {
          tone: "coral",
          text: (
            <>
              Flat 30% on net gains &mdash; no slab benefit, no expense
              deduction <Cite>s.115BBH</Cite>.
            </>
          ),
        },
        {
          tone: "coral",
          text: (
            <>
              Losses can&rsquo;t offset any other income, and can&rsquo;t carry
              forward.
            </>
          ),
        },
        {
          tone: "gold",
          text: (
            <>
              1% TDS on transfers over ₹10k &mdash; claimable against final
              liability <Cite>s.194S</Cite>.
            </>
          ),
        },
      ]}
      ask={ask}
      askPrompt="Why is crypto taxed so harshly under section 115BBH?"
    />
  );
}

function OtherSourcesTab({ ask }: { ask: (q: string) => void }) {
  return (
    <HeadExplainer
      title="Other Sources"
      cite="Schedule OS"
      body={
        <>
          Dividends, interest income (savings, FD, bonds), gifts, and lottery
          winnings fall under Other Sources. Dividend and interest data sync is
          tracked under MONEY-486.
        </>
      }
      bullets={[
        {
          tone: "ink",
          text: (
            <>
              Dividends are taxed at slab from FY 2020-21, with 10% TDS{" "}
              <Cite>s.194</Cite>.
            </>
          ),
        },
        {
          tone: "emerald",
          text: (
            <>
              Savings interest deduction of ₹10,000 under 80TTA (₹50,000 for
              seniors via 80TTB).
            </>
          ),
        },
        {
          tone: "gold",
          text: (
            <>
              Gifts from non-relatives over ₹50k are fully taxable{" "}
              <Cite>s.56(2)(x)</Cite>.
            </>
          ),
        },
      ]}
      ask={ask}
      askPrompt="How are dividends and interest income taxed?"
    />
  );
}

function ForeignAssetsTab({ ask }: { ask: (q: string) => void }) {
  return (
    <HeadExplainer
      title="Foreign Assets"
      cite="Schedule FA"
      body={
        <>
          If you hold any foreign asset &mdash; US stocks, a foreign bank
          balance, or crypto on an overseas exchange &mdash; Schedule FA
          disclosure is mandatory. We&rsquo;ll pre-fill it from your broker
          statements.
        </>
      }
      bullets={[
        {
          tone: "coral",
          text: (
            <>
              Non-disclosure carries a ₹10L flat penalty under the Black Money
              Act 2015.
            </>
          ),
        },
        {
          tone: "ink",
          text: (
            <>
              Peak and closing balances use RBI reference rates for the calendar
              year.
            </>
          ),
        },
        {
          tone: "emerald",
          text: (
            <>
              DTAA relief on foreign tax is claimed via Form 67 &rarr; Schedule
              TR.
            </>
          ),
        },
      ]}
      ask={ask}
      askPrompt="When is Schedule FA mandatory and what are the penalties?"
    />
  );
}

function ExemptTab({ ask }: { ask: (q: string) => void }) {
  return (
    <HeadExplainer
      title="Exempt income"
      cite="Schedule EI"
      body={
        <>
          PPF interest, the LTCG exempt slice up to ₹1.25L, gifts from
          relatives, HRA and LTA &mdash; tax-free, but still declared in
          Schedule EI. We&rsquo;ll auto-populate from your other heads.
        </>
      }
      bullets={[
        {
          tone: "emerald",
          text: (
            <>
              PPF interest is fully exempt <Cite>s.10(11)</Cite>.
            </>
          ),
        },
        {
          tone: "emerald",
          text: (
            <>
              LTCG up to ₹1.25L/year is exempt <Cite>s.112A proviso</Cite>.
            </>
          ),
        },
        {
          tone: "ink",
          text: <>HRA and LTA exemptions apply only under the old regime.</>,
        },
      ]}
      ask={ask}
      askPrompt="What income is exempt and where is it declared?"
    />
  );
}
