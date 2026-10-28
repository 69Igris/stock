"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import Link from "next/link";
import type { ActionBlock } from "@usemoney/types";
import {
  Check,
  X,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Zap,
  Flame,
  TrendingUp,
  Link2,
  Search,
  Clock,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import StockMentionPicker, {
  type MentionedSymbol,
} from "@/components/chat/StockMentionPicker";
import {
  resolveConfirmConfig,
  type CmAccent,
  type CmAction,
} from "@/lib/chat/confirm-config";
import "./chat-blocks.css";

const THINKING_PHRASES = [
  "Crunching the numbers...",
  "Sifting through financials...",
  "Analyzing market patterns...",
  "Scanning quarterly reports...",
  "Evaluating fundamentals...",
  "Cross-referencing data points...",
  "Mapping sector trends...",
  "Weighing risk factors...",
  "Benchmarking against peers...",
  "Synthesizing research...",
  "Connecting the dots...",
];

// Tools that operate on a specific stock (enables the "Wrong stock" repick).
const STOCK_TOOLS = new Set([
  "run_research",
  "get_financial_data",
  "get_stock_news",
  "run_comprehensive_analysis",
]);

/** Map the design's icon names to lucide components. */
const ICONS: Record<string, LucideIcon> = {
  alert: AlertTriangle,
  sparkles: Sparkles,
  zap: Zap,
  flame: Flame,
  trend: TrendingUp,
  link: Link2,
  search: Search,
  check: Check,
  x: X,
  refresh: RefreshCw,
  clock: Clock,
};

/** accent → border / icon-badge colors (mirrors the design CM_ACCENT). */
const ACCENT: Record<CmAccent, { bd: string; ic: string; icbg: string }> = {
  warning: { bd: "var(--gold)", ic: "#1d1d1b", icbg: "var(--gold-fill)" },
  danger: { bd: "var(--poor)", ic: "#fff", icbg: "var(--poor)" },
  emerald: { bd: "var(--emerald)", ic: "#fff", icbg: "var(--emerald-pure)" },
  info: { bd: "var(--blue)", ic: "#fff", icbg: "var(--blue)" },
  violet: { bd: "var(--purple)", ic: "#fff", icbg: "var(--purple)" },
  neutral: { bd: "var(--ink)", ic: "var(--paper)", icbg: "var(--ink)" },
};

const BROKER_DOT = [
  "var(--emerald-pure)",
  "var(--purple)",
  "var(--blue)",
  "var(--gold-fill)",
];

function useThinkingPhrase(isActive: boolean) {
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_PHRASES.length)
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (isActive) {
      intervalRef.current = setInterval(() => {
        setIndex((prev) => {
          let next: number;
          do {
            next = Math.floor(Math.random() * THINKING_PHRASES.length);
          } while (next === prev);
          return next;
        });
      }, 3000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive]);
  return THINKING_PHRASES[index]!;
}

interface ActionBlockRendererProps {
  block: ActionBlock;
  onConfirm?: (
    actionId: string,
    tool: string,
    params: Record<string, unknown>
  ) => void;
  onCancel?: (actionId: string) => void;
}

/** A chunky modal action button (cm-btn). */
function CmBtn({
  action,
  disabled,
  onClick,
}: {
  action: CmAction;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Ico = action.icon ? ICONS[action.icon] : undefined;
  return (
    <button
      type="button"
      className={`cm-btn ${action.kind}`}
      disabled={disabled}
      onClick={onClick}
    >
      {disabled && action.kind === "primary" ? (
        <Loader2
          style={{
            width: 14,
            height: 14,
            animation: "ss-spin 1s linear infinite",
          }}
        />
      ) : (
        Ico && <Ico style={{ width: 14, height: 14 }} strokeWidth={2.4} />
      )}
      {action.label}
    </button>
  );
}

export default function ActionBlockRenderer({
  block,
  onConfirm,
  onCancel,
}: ActionBlockRendererProps) {
  const [status, setStatus] = useState(block.status);
  const [isExecuting, setIsExecuting] = useState(false);
  const [showStockPicker, setShowStockPicker] = useState(false);
  const [pick, setPick] = useState(0);
  const phrase = useThinkingPhrase(
    status === "polling" || status === "confirmed"
  );

  useEffect(() => {
    setStatus(block.status);
    if (block.status !== "confirmed" && block.status !== "polling") {
      setIsExecuting(false);
    }
    if (block.status === "executed" || block.status === "failed") {
      setShowStockPicker(false);
    }
  }, [block.status]);

  const cfg = resolveConfirmConfig(block);
  const ac = ACCENT[cfg.accent] || ACCENT.neutral;
  const highlight = cfg.frame === "highlight";
  const isStockTool = STOCK_TOOLS.has(block.tool);

  const handleConfirm = (params: Record<string, unknown> = block.params) => {
    setIsExecuting(true);
    setStatus("confirmed");
    onConfirm?.(block.actionId, block.tool, params);
  };

  const handleCancel = () => {
    setStatus("cancelled");
    setShowStockPicker(false);
    onCancel?.(block.actionId);
  };

  // "repick" — disambiguation candidate confirm OR the live "Wrong stock" picker.
  const handleRepick = () => {
    if (cfg.candidates && cfg.candidates.length > 0) {
      const c = cfg.candidates[pick]!;
      const yahoo =
        c.exchange?.toUpperCase() === "BSE"
          ? `${c.ticker}.BO`
          : `${c.ticker}.NS`;
      const params = { ...block.params } as Record<string, unknown>;
      if (params.symbol) params.symbol = yahoo;
      if (Array.isArray(params.symbols)) params.symbols = [yahoo];
      handleConfirm(params);
      return;
    }
    setShowStockPicker(true);
    onCancel?.(block.actionId);
  };

  const handleMentionPick = (item: MentionedSymbol) => {
    setShowStockPicker(false);
    const yahoo =
      item.exchange?.toUpperCase() === "BSE"
        ? `${item.symbol}.BO`
        : `${item.symbol}.NS`;
    const params = { ...block.params } as Record<string, unknown>;
    if (params.symbol) params.symbol = yahoo;
    if (Array.isArray(params.symbols)) params.symbols = [yahoo];
    handleConfirm(params);
  };

  const runAction = (action: CmAction) => {
    if (action.result === "confirm") handleConfirm();
    else if (action.result === "cancelled") handleCancel();
    else handleRepick();
  };

  const HeadIcon = ICONS[cfg.icon] || AlertTriangle;
  const borderColor = highlight ? ac.bd : "var(--ink)";
  const cardStyle: CSSProperties = {
    borderColor,
    boxShadow: highlight
      ? `var(--shadow-soft, 0 1px 2px rgba(0,0,0,.06)), 0 0 0 3px color-mix(in srgb, ${ac.bd} 16%, transparent)`
      : undefined,
    margin: "6px 0",
  };

  const showPending = status === "pending" && !showStockPicker;
  const showProcessing = status === "confirmed" || status === "polling";

  return (
    <div className="cb-card cb-settle" style={cardStyle}>
      <div className="cb-head" style={{ paddingTop: 13 }}>
        <span
          className="cb-ico"
          style={{
            background: ac.icbg,
            color: ac.ic,
            borderColor: highlight ? ac.bd : "var(--ink)",
          }}
        >
          <HeadIcon style={{ width: 15, height: 15 }} />
        </span>
        <span className="cb-title">{cfg.title}</span>
      </div>

      <div className="cb-body" style={{ paddingTop: 11 }}>
        {showPending && (
          <>
            {cfg.body && <p className="cm-body-text">{cfg.body}</p>}

            {/* paid / roast: cost chips */}
            {cfg.cost && (
              <div className="cm-meta-row">
                <span className="cb-chip">
                  <Zap
                    style={{ width: 11, height: 11, color: "var(--gold-tx)" }}
                  />{" "}
                  {cfg.cost.credits} credits
                </span>
                {cfg.cost.eta && (
                  <span className="cb-chip">
                    <Clock style={{ width: 11, height: 11 }} /> {cfg.cost.eta}
                  </span>
                )}
                {cfg.cost.model && (
                  <span
                    className="cb-chip"
                    style={{
                      borderColor: "var(--purple)",
                      color: "var(--pop-5-text, var(--purple))",
                    }}
                  >
                    <Sparkles style={{ width: 11, height: 11 }} />{" "}
                    {cfg.cost.model}
                  </span>
                )}
              </div>
            )}

            {/* trade: order summary sub-card */}
            {cfg.order && (
              <div className="cm-order">
                <div className="cm-order-head">
                  <span className={`cm-side ${cfg.order.side.toLowerCase()}`}>
                    {cfg.order.side}
                  </span>
                  <span className="num" style={{ fontWeight: 700 }}>
                    {cfg.order.symbol}
                  </span>
                  <span className="cb-chip" style={{ marginLeft: "auto" }}>
                    PAPER
                  </span>
                </div>
                <div className="cb-kv">
                  <span className="k">Quantity</span>
                  <span className="v">{cfg.order.qty}</span>
                </div>
                <div className="cb-kv">
                  <span className="k">Order type</span>
                  <span className="v">{cfg.order.type}</span>
                </div>
                <div className="cb-kv">
                  <span className="k">Est. value</span>
                  <span className="v">{cfg.order.value}</span>
                </div>
              </div>
            )}

            {/* disambiguation: candidate radio list */}
            {cfg.candidates && cfg.candidates.length > 0 && (
              <div className="cm-candidates">
                {cfg.candidates.map((c, i) => (
                  <button
                    key={`${c.ticker}-${i}`}
                    type="button"
                    className={`cm-candidate${pick === i ? " on" : ""}`}
                    onClick={() => setPick(i)}
                  >
                    <span className="cm-radio">
                      {pick === i && <span className="dot" />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        className="num"
                        style={{ fontWeight: 700, fontSize: 12.5 }}
                      >
                        {c.ticker}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--ink-3)",
                        }}
                      >
                        {c.name}
                      </span>
                    </span>
                    <span className="cb-chip sm">{c.exchange}</span>
                  </button>
                ))}
              </div>
            )}

            {/* connect: broker chips */}
            {cfg.brokers && cfg.brokers.length > 0 && (
              <div className="cm-meta-row" style={{ marginTop: 4 }}>
                {cfg.brokers.map((b, i) => (
                  <span key={b} className="cb-chip">
                    <span
                      className="lg"
                      style={{ background: BROKER_DOT[i % BROKER_DOT.length] }}
                    />
                    {b}
                  </span>
                ))}
              </div>
            )}

            {/* actions */}
            <div className="cm-actions">
              {cfg.actions.map((a, i) => (
                <CmBtn
                  key={`${a.label}-${i}`}
                  action={a}
                  disabled={isExecuting && a.result === "confirm"}
                  onClick={() => runAction(a)}
                />
              ))}
            </div>
          </>
        )}

        {/* processing — confirm clicked / server polling */}
        {showProcessing && (
          <div className="cm-processing">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                marginBottom: 10,
              }}
            >
              <Loader2
                style={{
                  width: 15,
                  height: 15,
                  color: "var(--emerald)",
                  animation: "ss-spin 1s linear infinite",
                }}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {status === "polling"
                  ? (block.currentStep ?? phrase)
                  : cfg.processingText}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="cm-btn outline"
                onClick={handleCancel}
              >
                <X style={{ width: 14, height: 14 }} strokeWidth={2.4} />
                Stop
              </button>
            </div>
            <div className="cb-bar-track">
              <div
                className="cb-bar-fill cm-indeterminate"
                style={{ background: "var(--emerald-pure)" }}
              />
            </div>
          </div>
        )}

        {/* executed — confirmed outcome */}
        {status === "executed" && (
          <div className="cm-outcome ok">
            <span className="cm-outcome-ic ok">
              <Check style={{ width: 13, height: 13 }} strokeWidth={3} />
            </span>
            <span style={{ flex: 1 }}>{block.result ?? cfg.confirmedText}</span>
            {/*
              MONEY-1120 - render the CTA ONLY when it has somewhere to go.
              This was a bare <span> with `cursor: default`: it carried the
              cb-nav-link styling and the → arrow, so "Open run" read as a
              button while being incapable of navigating anywhere. Gating on
              confirmedHref means a destination-less variant now shows no CTA
              instead of a decorative one.
            */}
            {cfg.confirmedCta && cfg.confirmedHref && (
              <Link className="cb-nav-link" href={cfg.confirmedHref}>
                {cfg.confirmedCta}
                <ArrowRight style={{ width: 12, height: 12 }} />
              </Link>
            )}
          </div>
        )}

        {/* failed */}
        {status === "failed" && (
          <div className="cm-outcome muted" style={{ color: "var(--poor)" }}>
            <span
              className="cm-outcome-ic muted"
              style={{
                background: "rgba(232,98,61,.12)",
                color: "var(--poor)",
              }}
            >
              <AlertTriangle style={{ width: 13, height: 13 }} />
            </span>
            <span style={{ flex: 1 }}>
              {block.result ?? "Couldn't complete this. Please try again."}
            </span>
          </div>
        )}

        {/* cancelled */}
        {status === "cancelled" && !showStockPicker && (
          <div className="cm-outcome muted">
            <span className="cm-outcome-ic muted">
              <X style={{ width: 13, height: 13 }} strokeWidth={3} />
            </span>
            <span style={{ flex: 1 }}>{cfg.cancelledText}</span>
          </div>
        )}

        {/* live "Wrong stock" / "Edit" picker */}
        {showStockPicker && (
          <div style={{ marginTop: 4 }}>
            <StockMentionPicker
              visible={showStockPicker}
              initialTab="stocks"
              mode="mention"
              hideBrokers
              onSelect={handleMentionPick}
              onClose={() => setShowStockPicker(false)}
            />
          </div>
        )}
      </div>

      {cfg.disclaimer && showPending && (
        <div className="cb-disclaimer">{cfg.disclaimer}</div>
      )}
    </div>
  );
}
