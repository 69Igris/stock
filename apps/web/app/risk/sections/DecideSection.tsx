"use client";

/**
 * Risk v2 (MONEY-485) — Decide section.
 *
 * Turns diagnosis into action: top ranked rebalance moves (REAL — from
 * PortfolioRiskResult.rebalancing, ranked by absolute drift), each with a
 * tax-cost cross-link to /tax and a rebalance-confirm dialog; a pre-trade
 * check dialog; the full rebalancing table; and a behaviour coach (needs
 * trade-history analytics — MONEY-487).
 *
 * Tax amounts and risk-impact deltas shown inside the dialogs are estimates
 * the user is told to verify on /tax — they are not server-computed tax
 * figures, and are clearly framed as such. No fabricated risk metrics.
 */

import { useState } from "react";
import Link from "next/link";
import type { PortfolioRiskResult } from "@/lib/actions/risk";
import { ArrowRight, Target, User, Receipt, Play } from "lucide-react";
import RebalancingTable from "../components/RebalancingTable";
import RiskDialog from "../components/RiskDialog";
import { ComingSoon, fmtINRCompact } from "../components/primitives";

interface Props {
  data: PortfolioRiskResult;
  ask: (q: string) => void;
}

type RebalHolding = PortfolioRiskResult["rebalancing"]["holdings"][number];

const MOVE_TONES = ["var(--pop-2)", "var(--pop-3)", "var(--pop-5)"];

export default function DecideSection({ data, ask }: Props) {
  const [confirmMove, setConfirmMove] = useState<RebalHolding | null>(null);
  const [preTradeOpen, setPreTradeOpen] = useState(false);

  const rebal = data.rebalancing;
  // Real ranked moves: actionable holdings (buy/sell) by largest drift.
  const moves = (rebal?.holdings ?? [])
    .filter((h) => h.action !== "hold" && h.amount !== 0)
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
    .slice(0, 3);

  return (
    <div className="flex flex-col gap-4">
      {/* ── Ranked moves ── */}
      <div className="pf-sec-h flex-wrap">
        <span className="n">04 · DECIDE</span>
        <h3>
          Top moves, <span className="ser">ranked.</span>
        </h3>
        <span className="rule hidden sm:block" />
        <span className="meta">by drift from equal-weight target</span>
      </div>

      {moves.length === 0 ? (
        <div className="pf-card flat" style={{ padding: 18 }}>
          <p className="text-[14px] font-bold text-[var(--ink-2)]">
            {rebal?.needsRebalancing
              ? "No single-name moves cross the drift threshold."
              : "Your book is within its drift band — no rebalance suggested right now."}
          </p>
          <p className="text-[12px] text-[var(--ink-3)] mt-1">
            Drift threshold {((rebal?.driftThreshold ?? 0.05) * 100).toFixed(0)}
            % · total drift {((rebal?.totalDrift ?? 0) * 100).toFixed(1)}%.
          </p>
        </div>
      ) : (
        <>
          {/* Top move — yellow hero */}
          {moves[0] && (
            <TopMove
              move={moves[0]}
              onShowPlan={() => setConfirmMove(moves[0])}
            />
          )}
          {/* Other two */}
          {moves.length > 1 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
              {moves.slice(1).map((m, i) => (
                <MoveCard
                  key={m.symbol}
                  move={m}
                  rank={i + 2}
                  tone={MOVE_TONES[i + 1] ?? "var(--pop-3)"}
                  onRun={() => setConfirmMove(m)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Full table */}
      <RebalancingTable data={rebal} />

      {/* ── Pre-trade check launcher ── */}
      <div className="pf-sec-h flex-wrap">
        <span className="n">04 · PRE-TRADE</span>
        <h3>
          Sanity check, <span className="ser">before you click buy.</span>
        </h3>
        <span className="rule hidden sm:block" />
      </div>
      <div
        className="pf-card flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        style={{ padding: 18 }}
      >
        <div className="flex items-start gap-3">
          <span
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: "var(--pop-3)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            <Target className="h-5 w-5" />
          </span>
          <div>
            <div className="text-[15px] font-extrabold text-[var(--ink)]">
              Pre-trade risk check
            </div>
            <div className="ser text-[13.5px] text-[var(--ink-3)]">
              See how an order shifts your concentration and beta before you
              place it.
            </div>
          </div>
        </div>
        <button
          className="pf-bs sm flex-shrink-0"
          onClick={() => setPreTradeOpen(true)}
        >
          <Play className="h-3 w-3" /> Run a check
        </button>
      </div>

      {/* ── Behaviour coach (needs trade-history analytics) ── */}
      <div className="pf-sec-h flex-wrap">
        <span className="n">04 · COACH</span>
        <h3>
          Your <span className="ser">behaviour</span> over time.
        </h3>
        <span className="rule hidden sm:block" />
      </div>
      <ComingSoon
        title="Behaviour coach"
        body="Panic-sell detection, overtrading flags and tolerance-mismatch nudges read from your trade history. The behavioural analytics pipeline is tracked in MONEY-487."
        icon={<User className="h-9 w-9" />}
      />

      {/* ── Dialogs ── */}
      <RebalanceConfirmDialog
        move={confirmMove}
        onClose={() => setConfirmMove(null)}
        ask={ask}
      />
      <PreTradeDialog
        open={preTradeOpen}
        onClose={() => setPreTradeOpen(false)}
        data={data}
      />
    </div>
  );
}

/* ── Top move (yellow hero card) ─────────────────────────────────── */

function TopMove({
  move,
  onShowPlan,
}: {
  move: RebalHolding;
  onShowPlan: () => void;
}) {
  const isSell = move.action === "sell";
  return (
    <div
      className="pf-card"
      style={{
        background: "var(--pop-2)",
        border: "2px solid var(--ink)",
        boxShadow: "var(--shadow-hard)",
        padding: 18,
      }}
    >
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="pf-pill"
              style={{
                background: "#1d1d1b",
                color: "var(--pop-2)",
                borderColor: "#1d1d1b",
              }}
            >
              ★ TOP MOVE
            </span>
            <span className="mono text-[11px] text-[#3a3a35] tracking-wide">
              {(Math.abs(move.drift) * 100).toFixed(1)}% drift ·{" "}
              {fmtINRCompact(Math.abs(move.amount))}
            </span>
          </div>
          <div className="text-[20px] sm:text-[22px] font-extrabold text-[#1d1d1b] tracking-[-0.6px] leading-tight mt-2.5">
            {isSell ? "Trim" : "Add to"}{" "}
            <span
              style={{
                background: "#1d1d1b",
                color: "var(--pop-2)",
                padding: "0 7px",
                borderRadius: 5,
              }}
            >
              {move.symbol}
            </span>{" "}
            by {fmtINRCompact(Math.abs(move.amount))}
          </div>
          <div className="ser text-[14.5px] text-[#3a3a35] leading-relaxed mt-2">
            Moves {move.symbol} from {(move.currentWeight * 100).toFixed(1)}%
            toward its {(move.targetWeight * 100).toFixed(1)}% equal-weight
            target.{" "}
            {isSell
              ? "Selling can trigger capital-gains tax — check the impact before you act."
              : "Funded from your most-overweight names."}
          </div>
        </div>
        <div className="flex flex-row sm:flex-col gap-2 flex-shrink-0">
          <button
            className="pf-bs sm"
            style={{
              background: "#1d1d1b",
              borderColor: "#1d1d1b",
              color: "var(--pop-2)",
            }}
            onClick={onShowPlan}
          >
            Show plan <ArrowRight className="h-3 w-3" />
          </button>
          <Link
            href="/tax"
            className="pf-bf sm"
            style={{ borderColor: "#1d1d1b", color: "#1d1d1b" }}
          >
            Tax impact <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ── Secondary move card ─────────────────────────────────────────── */

function MoveCard({
  move,
  rank,
  tone,
  onRun,
}: {
  move: RebalHolding;
  rank: number;
  tone: string;
  onRun: () => void;
}) {
  const isSell = move.action === "sell";
  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="flex items-center gap-3">
        <span
          className="mono"
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: tone,
            color: "var(--paper)",
            border: "1.5px solid var(--ink)",
            display: "grid",
            placeItems: "center",
            transform: "rotate(-3deg)",
            fontWeight: 800,
            flexShrink: 0,
          }}
        >
          {rank}
        </span>
        <div className="text-[15px] font-extrabold text-[var(--ink)] tracking-[-0.3px]">
          {isSell ? "Trim" : "Add to"} {move.symbol}
        </div>
      </div>
      <div className="ser text-[14px] text-[var(--ink-3)] mt-2.5">
        {(move.currentWeight * 100).toFixed(1)}% →{" "}
        {(move.targetWeight * 100).toFixed(1)}% target.
      </div>
      <div
        className="flex items-center justify-between mt-3 pt-2.5"
        style={{ borderTop: "1px dashed var(--rule-soft)" }}
      >
        <span className="mono text-[12px] text-[var(--ink-3)]">
          {isSell ? "−" : "+"}
          {fmtINRCompact(Math.abs(move.amount))} ·{" "}
          <span style={{ color: "var(--emerald-text)", fontWeight: 700 }}>
            {(Math.abs(move.drift) * 100).toFixed(1)}% drift
          </span>
        </span>
        <button className="pf-bf sm" onClick={onRun}>
          Run it
        </button>
      </div>
    </div>
  );
}

/* ── Rebalance confirm dialog ────────────────────────────────────── */

function RebalanceConfirmDialog({
  move,
  onClose,
  ask,
}: {
  move: RebalHolding | null;
  onClose: () => void;
  ask: (q: string) => void;
}) {
  if (!move) return null;
  const isSell = move.action === "sell";

  return (
    <RiskDialog
      open={!!move}
      onClose={onClose}
      eyebrow="REBALANCE · CONFIRM"
      title={
        <>
          {isSell ? "Trim" : "Add to"} {move.symbol}
        </>
      }
      footer={
        <>
          <button className="pf-bf sm" onClick={onClose}>
            Cancel
          </button>
          <Link href="/tax" className="pf-bf sm">
            <Receipt className="h-3 w-3" /> Check tax on /tax
          </Link>
          <button
            className="pf-bs sm"
            onClick={() => {
              ask(
                `Help me ${isSell ? "trim" : "add to"} ${move.symbol} by ${fmtINRCompact(Math.abs(move.amount))} to rebalance my portfolio`
              );
              onClose();
            }}
          >
            Plan with StockSage <ArrowRight className="h-3 w-3" />
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3">
          {[
            {
              l: "ACTION",
              v: move.action.toUpperCase(),
              c: isSell ? "var(--pop-1-text)" : "var(--emerald-text)",
            },
            {
              l: "AMOUNT",
              v: fmtINRCompact(Math.abs(move.amount)),
              c: "var(--ink)",
            },
            {
              l: "DRIFT",
              v: `${(Math.abs(move.drift) * 100).toFixed(1)}%`,
              c: "var(--pop-2-text)",
            },
          ].map((c) => (
            <div
              key={c.l}
              className="rounded-lg p-3"
              style={{
                background: "var(--rule-softer)",
                border: "1.5px solid var(--rule-soft)",
              }}
            >
              <div className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)]">
                {c.l}
              </div>
              <div
                className="mono text-[18px] font-bold mt-1"
                style={{ color: c.c }}
              >
                {c.v}
              </div>
            </div>
          ))}
        </div>
        <div
          className="rounded-lg p-3"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="text-[13px] text-[var(--ink-2)] leading-relaxed">
            This shifts {move.symbol} from{" "}
            <b className="mono">{(move.currentWeight * 100).toFixed(1)}%</b> to
            its <b className="mono">{(move.targetWeight * 100).toFixed(1)}%</b>{" "}
            equal-weight target.
          </div>
        </div>
        <p className="text-[11px] text-[var(--ink-3)]">
          We don&apos;t place orders here. Capital-gains tax on sells is
          estimated on the{" "}
          <Link href="/tax" className="underline">
            /tax
          </Link>{" "}
          page — confirm there before acting. Educational, not advice.
        </p>
      </div>
    </RiskDialog>
  );
}

/* ── Pre-trade check dialog ──────────────────────────────────────── */

function PreTradeDialog({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: PortfolioRiskResult;
}) {
  const [symbol, setSymbol] = useState("");
  const [amount, setAmount] = useState("");
  const beta = data.beta?.beta ?? null;
  const topWeight = data.concentration?.topHoldings?.[0]?.weight ?? null;

  return (
    <RiskDialog
      open={open}
      onClose={onClose}
      eyebrow="PRE-TRADE · RISK CHECK"
      title="Will this order change your risk?"
      footer={
        <button className="pf-bs sm" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
              Symbol
            </div>
            <input
              className="pf-input"
              placeholder="e.g. RELIANCE"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <div className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
              Amount (₹)
            </div>
            <input
              className="pf-input"
              placeholder="e.g. 50000"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div
            className="rounded-lg p-3"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <div className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)]">
              Current beta
            </div>
            <div className="mono text-[18px] font-bold mt-1 text-[var(--ink)]">
              {beta !== null ? beta.toFixed(2) : "—"}
            </div>
          </div>
          <div
            className="rounded-lg p-3"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <div className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)]">
              Top weight
            </div>
            <div className="mono text-[18px] font-bold mt-1 text-[var(--ink)]">
              {topWeight !== null ? `${(topWeight * 100).toFixed(1)}%` : "—"}
            </div>
          </div>
          <div
            className="rounded-lg p-3"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <div className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)]">
              HHI
            </div>
            <div className="mono text-[18px] font-bold mt-1 text-[var(--ink)]">
              {data.concentration?.hhi
                ? data.concentration.hhi.toLocaleString("en-IN")
                : "—"}
            </div>
          </div>
        </div>

        <div
          className="flex items-start gap-2 rounded-md px-3 py-2"
          style={{
            background: "var(--rule-softer)",
            border: "1.5px dashed var(--rule-soft)",
          }}
        >
          <span className="pf-pill outline" style={{ fontSize: 9 }}>
            COMING SOON
          </span>
          <span className="text-[11.5px] text-[var(--ink-3)] leading-snug">
            Live post-trade beta, concentration and margin deltas need an order
            pricing + greeks pipeline (MONEY-487). For now these show your
            current book; we never invent a post-trade number.
          </span>
        </div>
      </div>
    </RiskDialog>
  );
}
