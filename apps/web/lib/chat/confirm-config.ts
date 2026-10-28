/**
 * ConfirmModal config resolver (MONEY-587, StockSage design).
 *
 * Maps an ActionBlock to the variant config that drives the confirmation card
 * (icon, accent, chips, order sub-card, broker chips, disclaimer, buttons).
 * A producer (lib/chat-tools/registry.ts, task #22) may populate the ActionBlock
 * variant fields directly; when it hasn't, we infer sensible defaults from
 * `tool` so the card still renders the right variant. Pure + unit-testable.
 */

import type { ActionBlock } from "@usemoney/types";
// MONEY-650 (B2): compute the research confirmation credits the same way
// lib/actions/research.ts bills — base action cost + per-model premium — and
// label the real model, instead of a hardcoded "3 credits / Pro + grounding".
import { CREDIT_COSTS } from "@usemoney/core/subscription/plans";
import {
  getEffectiveCreditCost,
  getModelDefinition,
} from "@usemoney/core/gemini/model-registry";

export type CmAccent =
  | "warning"
  | "danger"
  | "emerald"
  | "info"
  | "violet"
  | "neutral";
export type CmKind = "primary" | "outline" | "danger";
export type CmResult = "confirm" | "cancelled" | "repick";

export interface CmAction {
  label: string;
  icon?: string;
  kind: CmKind;
  result: CmResult;
}

export interface ConfirmConfig {
  variant: string;
  accent: CmAccent;
  frame: "default" | "highlight";
  icon: string;
  title: string;
  body?: string;
  cost?: { credits: number; eta?: string; model?: string };
  order?: {
    side: "BUY" | "SELL";
    symbol: string;
    qty: string;
    type: string;
    value: string;
  };
  brokers?: string[];
  candidates?: Array<{ ticker: string; name: string; exchange: string }>;
  disclaimer?: string;
  actions: CmAction[];
  confirmedText: string;
  confirmedCta?: string;
  /**
   * MONEY-1120 - where `confirmedCta` actually navigates. Resolved per variant
   * from the block's `sessionId`; undefined when there is nothing to open (no
   * session id yet, or a variant with no destination). The renderer MUST NOT
   * draw the CTA without this — it previously rendered `confirmedCta` as a
   * bare <span>, so "Open run →" looked like a button and did nothing.
   */
  confirmedHref?: string;
  cancelledText: string;
  processingText: string;
}

/** Tool → default variant when the producer hasn't set ActionBlock.variant. */
export function variantForTool(tool: string): ConfirmConfig["variant"] {
  switch (tool) {
    case "run_research":
    case "run_comprehensive_analysis":
      return "research";
    case "start_roast":
      return "roast";
    case "buy_paper_position":
    case "sell_paper_position":
      return "trade";
    case "connect_broker":
      return "connect";
    case "disconnect_broker":
      return "danger";
    default:
      return "generic";
  }
}

const RESEARCH_ACTIONS: CmAction[] = [
  {
    label: "Start Research",
    icon: "check",
    kind: "primary",
    result: "confirm",
  },
  { label: "Wrong stock", icon: "refresh", kind: "outline", result: "repick" },
  { label: "Cancel", icon: "x", kind: "outline", result: "cancelled" },
];

/** Per-variant defaults (title/body are overridden by the block where present). */
function variantDefaults(variant: string): Omit<ConfirmConfig, "variant"> {
  switch (variant) {
    case "research":
      return {
        accent: "emerald",
        frame: "default",
        icon: "sparkles",
        title: "Start comprehensive research?",
        body: "Runs a Deep, cited multi-section report — fundamentals, valuation, technicals, news.",
        actions: RESEARCH_ACTIONS,
        confirmedText: "Research started — tracking in your Research tab.",
        confirmedCta: "Open run",
        cancelledText: "Research cancelled.",
        processingText: "Starting research run…",
      };
    case "paid":
      return {
        accent: "violet",
        frame: "default",
        icon: "zap",
        title: "Run Deep Research?",
        body: "Deep uses the Pro model with Google-grounding and full live sources — slower, but more thorough than AUTO.",
        actions: [
          { label: "Run", icon: "zap", kind: "primary", result: "confirm" },
          {
            label: "Use AUTO (free)",
            icon: "x",
            kind: "outline",
            result: "cancelled",
          },
        ],
        confirmedText: "Deep run started.",
        confirmedCta: "Open run",
        cancelledText: "Kept it on AUTO — no credits used.",
        processingText: "Spinning up Deep research…",
        disclaimer: "Educational analysis only — not advice.",
      };
    case "roast":
      return {
        accent: "danger",
        frame: "default",
        icon: "flame",
        title: "Roast my portfolio?",
        body: "An unfiltered AI critique of your holdings — concentration, churn, tax drag and conviction. It pulls no punches.",
        actions: [
          { label: "Run", icon: "flame", kind: "primary", result: "confirm" },
          { label: "Cancel", icon: "x", kind: "outline", result: "cancelled" },
        ],
        confirmedText: "Roast started.",
        confirmedCta: "Open roast",
        cancelledText: "Saved your ego — cancelled.",
        processingText: "Lighting the roast…",
        disclaimer: "Observational critique only — not investment advice.",
      };
    case "trade":
      return {
        accent: "emerald",
        frame: "default",
        icon: "trend",
        title: "Confirm paper order",
        actions: [
          {
            label: "Place paper order",
            icon: "check",
            kind: "primary",
            result: "confirm",
          },
          { label: "Edit", icon: "refresh", kind: "outline", result: "repick" },
          { label: "Cancel", icon: "x", kind: "outline", result: "cancelled" },
        ],
        confirmedText: "Paper order placed — added to your virtual tradebook.",
        confirmedCta: "View tradebook",
        cancelledText: "Order discarded.",
        processingText: "Placing paper order…",
        disclaimer:
          "Paper trading only — no real money, no orders sent to any exchange. Not investment advice.",
      };
    case "connect":
      return {
        accent: "info",
        frame: "default",
        icon: "link",
        title: "Connect a broker to continue",
        body: "To show your live holdings here, connect a broker. StockSage uses read-only access — it can never place trades.",
        brokers: ["Zerodha", "Upstox", "Groww", "Dhan"],
        actions: [
          {
            label: "Connect",
            icon: "link",
            kind: "primary",
            result: "confirm",
          },
          { label: "Not now", icon: "x", kind: "outline", result: "cancelled" },
        ],
        confirmedText: "Broker connected — syncing holdings.",
        confirmedCta: "View holdings",
        cancelledText: "No broker connected.",
        processingText: "Opening secure broker login…",
      };
    case "danger":
      return {
        accent: "danger",
        frame: "highlight",
        icon: "alert",
        title: "Disconnect broker?",
        body: "Holdings from this broker will stop syncing into StockSage. This won't sell or modify anything in your broker account.",
        actions: [
          { label: "Disconnect", icon: "x", kind: "danger", result: "confirm" },
          { label: "Cancel", icon: "x", kind: "outline", result: "cancelled" },
        ],
        confirmedText: "Broker disconnected.",
        cancelledText: "Kept the broker connected.",
        processingText: "Disconnecting broker…",
      };
    case "generic":
    default:
      return {
        accent: "warning",
        frame: "highlight",
        icon: "alert",
        title: "Confirm this action?",
        body: "This action requires your confirmation.",
        actions: [
          {
            label: "Confirm",
            icon: "check",
            kind: "primary",
            result: "confirm",
          },
          { label: "Cancel", icon: "x", kind: "outline", result: "cancelled" },
        ],
        confirmedText: "Action confirmed.",
        cancelledText: "Action cancelled.",
        processingText: "Working…",
      };
  }
}

/**
 * MONEY-1120 - destination for a variant's post-confirm CTA.
 *
 * Returns undefined when there is nothing to open, which is the signal for the
 * renderer to omit the CTA entirely rather than draw a link-shaped element
 * that goes nowhere. `/analysis/:id` mirrors the "View Full Analysis"
 * navigation link ChatContext already appends on research completion.
 */
export function confirmedHrefFor(
  variant: string,
  sessionId?: string
): string | undefined {
  const id = sessionId ? encodeURIComponent(sessionId) : "";
  switch (variant) {
    case "research":
    case "paid":
      return id ? `/analysis/${id}` : undefined;
    case "roast":
      return id ? `/roast/${id}` : "/roast";
    case "trade":
      return "/tradebook";
    case "connect":
      return "/holdings";
    default:
      return undefined;
  }
}

/** Resolve the final confirmation config: variant defaults + block overrides. */
export function resolveConfirmConfig(block: ActionBlock): ConfirmConfig {
  const variant = block.variant || variantForTool(block.tool);
  const base = variantDefaults(variant);

  // A populated `paid` block (deep research with credits) outranks the plain
  // research variant for the same tool.
  const effectiveVariant =
    !block.variant && variant === "research" && block.credits != null
      ? "paid"
      : variant;
  const def =
    effectiveVariant === variant ? base : variantDefaults(effectiveVariant);

  const cost =
    block.credits != null
      ? { credits: block.credits, eta: block.eta, model: block.model }
      : def.cost;

  return {
    ...def,
    variant: effectiveVariant,
    confirmedHref: confirmedHrefFor(effectiveVariant, block.sessionId),
    accent: block.accent || def.accent,
    frame: block.frame || def.frame,
    icon: block.icon || def.icon,
    title: block.description || def.title,
    cost,
    order: block.order || def.order,
    brokers: block.brokers || def.brokers,
    candidates: block.candidates || def.candidates,
    disclaimer: block.disclaimer ?? def.disclaimer,
  };
}

/**
 * Producer-side: derive the ActionBlock variant DATA fields from a tool + its
 * params at confirmation-block creation time (route.ts / message-parser). The
 * renderer infers the variant + copy from `tool`; this only supplies data that
 * can't be inferred — the paper-order sub-card, roast credit cost, broker chips.
 */
export function buildConfirmFields(
  tool: string,
  params: Record<string, unknown>
): Partial<{
  order: ConfirmConfig["order"];
  credits: number;
  eta: string;
  model: string;
  brokers: string[];
}> {
  if (tool === "run_research" || tool === "run_comprehensive_analysis") {
    // Surface the paid-credits card (Deep vs AUTO) for research confirmations.
    // Mirrors the credit ladder in lib/actions/research.ts: fast = 1 credit,
    // advanced/deep = 3, multi-stock comparison scales 8 + 8 per extra stock.
    // Setting `credits` here is what makes resolveConfirmConfig() promote the
    // plain `research` variant to `paid`.
    const mode = String(params.mode ?? "");
    const symbols = Array.isArray(params.symbols)
      ? (params.symbols as unknown[]).filter(Boolean)
      : [];
    const isComparison = symbols.length > 1;
    const isDeep = mode === "advanced";

    // Mirror the credit ladder in lib/actions/research.ts EXACTLY: a base
    // action cost + the per-model premium (getEffectiveCreditCost).
    let creditAction: string;
    let baseCredits: number;
    let eta: string;
    if (isComparison) {
      creditAction = "l3_multi_comparison_base";
      baseCredits =
        (CREDIT_COSTS["l3_multi_comparison_base"] ?? 8) +
        (CREDIT_COSTS["l3_multi_comparison_per_stock"] ?? 8) *
          (symbols.length - 1);
      eta = "~2-3 min";
    } else if (isDeep) {
      creditAction = "l2_research_advanced";
      baseCredits = CREDIT_COSTS["l2_research_advanced"] ?? 3;
      eta = "~3-6 min";
    } else {
      creditAction = "l2_research_fast";
      baseCredits = CREDIT_COSTS["l2_research_fast"] ?? 1;
      eta = "~30s";
    }

    // params.model is the research deep-lane model the run actually uses
    // (route.ts enriches it via resolveResearchModel), so base + its premium
    // is what billing will charge — no longer a flat hardcoded 3.
    const rawModel = typeof params.model === "string" ? params.model : "";
    const credits = rawModel
      ? getEffectiveCreditCost(creditAction, rawModel, baseCredits)
      : baseCredits;

    // Friendly model name from the registry ("Gemini 3 Pro") rather than the
    // generic "Pro + grounding" — the card showed the wrong model before.
    const def = rawModel ? getModelDefinition(rawModel) : null;
    const model = def
      ? def.displayName
      : rawModel && rawModel !== "gemini-2.5-flash"
        ? "Pro + grounding"
        : undefined;

    return { credits, eta, ...(model ? { model } : {}) };
  }
  if (tool === "buy_paper_position" || tool === "sell_paper_position") {
    const side = tool === "buy_paper_position" ? "BUY" : "SELL";
    const symbol = String(params.symbol ?? "")
      .toUpperCase()
      .replace(/\.(NS|BO|NSE|BSE)$/i, "");
    const qty = Number(params.quantity) || 0;
    const price = Number(params.price) || 0;
    if (!symbol || qty <= 0) return {};
    return {
      order: {
        side,
        symbol,
        qty: `${qty} ${qty === 1 ? "share" : "shares"}`,
        type: String(params.orderType ?? "Market"),
        value:
          price > 0
            ? `≈ ₹${Math.round(qty * price).toLocaleString("en-IN")}`
            : "Market",
      },
    };
  }
  if (tool === "start_roast") {
    // Roast requires confirmation at 5 credits (or 1 free roast/month).
    return { credits: 5, eta: "~30s" };
  }
  if (tool === "connect_broker") {
    return { brokers: ["Zerodha", "Upstox", "Groww", "Dhan"] };
  }
  return {};
}
