"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Brain,
  Loader2,
  FileText,
  Paperclip,
  Sparkles,
  Zap,
  Microscope,
  Layers,
  Atom,
  Wand2,
  ChevronDown,
  Check,
  BarChart3,
  Activity,
  TrendingUp,
  Target,
  PieChart,
  Users,
  Waves,
  LineChart,
  ShieldAlert,
  Globe,
  FolderOpen,
  SlidersHorizontal,
} from "lucide-react";
import { startResearchAction } from "@/lib/actions/research";
import { checkAICreditsAction } from "@/lib/actions/subscription";
import { DocumentVaultPanel } from "@/components/documents/DocumentVaultPanel";
import { NoCreditDialog } from "@/components/NoCreditDialog";
import { useResearchPreferences } from "@/hooks/useResearchPreferences";
import { useComposerPreferences } from "@/hooks/useComposerPreferences";
import { useSubscriptionAccess } from "@/hooks/useSubscriptionAccess";
import {
  RESEARCH_PRESET_DEFS,
  RESEARCH_SKILL_LABELS,
  RESEARCH_SKILL_DESCRIPTIONS,
  RESEARCH_HORIZONS,
  RESEARCH_BENCHMARKS,
  RESEARCH_REPORT_LENGTHS,
  expandSkillAliases,
  resolveEffectiveSkills,
  type ResearchSkillId,
  type ResearchHorizon,
  type ResearchReportLength,
} from "@usemoney/services/preferences";
import {
  getPickerModelsForUser,
  type ModelDefinition,
} from "@usemoney/core/gemini/model-registry";
import { useUser } from "@clerk/nextjs";
import {
  ModelBrandMark,
  providerToFamily,
} from "@/components/chat/options/ModelBrandMark";
// MONEY-779 / MONEY-801 — pure run-param + style helpers live in a sibling so
// they're unit-testable without this `"use client"` component's React deps.
import {
  styleToMode,
  styleToPresetId,
  clampName,
  buildRunParamsExtras,
  type ResearchStyle,
} from "@/components/analysis/research-modal-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface ResearchEntity {
  symbol: string;
  name: string;
  type: "stock" | "mf" | "etf";
  exchange?: string;
}

export interface PositionPreData {
  status: "open" | "closed";
  quantity: number;
  purchasePrice: number;
  purchaseDate: string;
  currentPrice?: number;
  unrealizedPnL?: number;
  sellPrice?: number;
  sellDate?: string;
  realizedPnL?: number;
}

interface ResearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: ResearchEntity | null;
  positionData?: PositionPreData | null;
  /**
   * MONEY-394 K - When 2+ entities are provided, the modal runs in
   * comparison mode: query becomes `Compare A vs B vs …`, the
   * peer-comparison skill is appended, and symbols[] carries all of
   * them. `entity` is ignored when this is non-empty (the toolbar
   * passes `null`).
   */
  compareEntities?: readonly ResearchEntity[];
}

interface StyleOption {
  id: ResearchStyle;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  tier?: "L1" | "L2" | "L3" | "L4";
  blurb: string;
  meta: string;
  accent: string;
}

const STYLES: StyleOption[] = [
  {
    id: "auto",
    label: "Auto",
    Icon: Sparkles,
    blurb: "StockSage picks plan depth.",
    meta: "~1m · 1 cr",
    accent: "#34d399",
  },
  {
    id: "quick",
    label: "Quick",
    Icon: Zap,
    tier: "L1",
    blurb: "Fundamentals snapshot + 4Q.",
    meta: "~30s · 1 cr",
    accent: "#fbbf24",
  },
  {
    id: "deep",
    label: "Deep",
    Icon: Microscope,
    tier: "L2",
    blurb: "Multi-step + peer + macro.",
    meta: "~3m · 4 cr",
    accent: "#a78bfa",
  },
  {
    id: "comprehensive",
    label: "Comprehensive",
    Icon: Layers,
    tier: "L3",
    blurb: "Deep + governance + sentiment.",
    meta: "~6m · 6 cr",
    accent: "#34d399",
  },
  {
    id: "advanced",
    label: "Advanced",
    Icon: Atom,
    tier: "L4",
    blurb: "Quant + chart patterns + scenarios.",
    meta: "~12m · 12 cr",
    accent: "#f97316",
  },
  {
    id: "custom",
    label: "Custom",
    Icon: Wand2,
    blurb: "Run only your pinned skills.",
    meta: "varies",
    accent: "#3b82f6",
  },
];

// ── Component ──────────────────────────────────────────────────────

export default function ResearchModal({
  open,
  onOpenChange,
  entity,
  positionData,
  compareEntities,
}: ResearchModalProps) {
  const isCompareMode =
    Array.isArray(compareEntities) && compareEntities.length >= 2;
  const router = useRouter();
  const { prefs, save } = useResearchPreferences();
  const { prefs: composerPrefs, save: saveComposer } = useComposerPreferences();
  // MONEY-626: founder-gated Claude models in the research picker (cosmetic;
  // the worker re-resolves with the server gate). Non-founders see Gemini only.
  const { user } = useUser();

  const [instructions, setInstructions] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [noCreditDialogOpen, setNoCreditDialogOpen] = useState(false);
  const [noCreditReason, setNoCreditReason] = useState<"free" | "no_credits">(
    "free"
  );

  // Style + model picker state - initialised from saved prefs
  const savedStyle = (prefs?.researchStyle ?? "auto") as ResearchStyle;
  const [style, setStyle] = useState<ResearchStyle>(savedStyle);

  // MONEY-394 I - FREE users are restricted to {auto, quick, deep}.
  // Comprehensive / Advanced / Custom remain visible with a 'Pro' chip
  // and clicking them surfaces an upgrade toast.
  //
  // MONEY-457: gate ONLY when we know the user's plan. The hook's `planId`
  // defaults to "FREE" while the /api/subscription/access fetch is in
  // flight; a Premium user who clicked Advanced inside that window was
  // getting the "Pro feature" toast incorrectly. Treat unknown / loading
  // as "not free" so the optimistic UX is permissive, and let the server-
  // side credit check at handleStartResearch be the final authority.
  const { planId, isLoading: planLoading } = useSubscriptionAccess(false);
  const isFreePlan = !planLoading && planId === "FREE";
  const PRO_ONLY_STYLES: readonly ResearchStyle[] = [
    "comprehensive",
    "advanced",
    "custom",
  ];
  const handleStyleClick = (next: ResearchStyle) => {
    if (isFreePlan && PRO_ONLY_STYLES.includes(next)) {
      toast.error(
        `${next.charAt(0).toUpperCase()}${next.slice(1)} research is a Pro feature - upgrade to unlock.`,
        { duration: 4000 }
      );
      return;
    }
    setStyle(next);
  };

  // Custom skills picker - only meaningful when style="custom".
  const savedSkills = useMemo(
    () => expandSkillAliases((prefs?.customSkills ?? []) as ResearchSkillId[]),
    [prefs?.customSkills]
  );
  const [customSkills, setCustomSkills] =
    useState<ResearchSkillId[]>(savedSkills);
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  // MONEY-801 — institutional run-parameters (C1c UI producer). The backend
  // is fully wired (schema → startResearchAction extras → ResearchJobMessage →
  // agent.run); these controls are the missing producer. Everything defaults
  // to "unset" so an untouched run reproduces today's plan + report exactly:
  //   horizon undefined → per-skill default · benchmark undefined → ^NSEI ·
  //   reportLength "standard" → today's advanced-prompt depth · VaR 95% / 1d ·
  //   assumptions undefined → each tool's own default (WACC, terminal-growth…).
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const [horizon, setHorizon] = useState<ResearchHorizon | undefined>(
    undefined
  );
  // Empty string = "Default (NIFTY 50)". A known id or a free-text sector
  // (per the schema's `.enum(...).or(z.string())`) maps to a symbol downstream.
  const [benchmark, setBenchmark] = useState<string>("");
  const [reportLength, setReportLength] =
    useState<ResearchReportLength>("standard");
  const [varConfidence, setVarConfidence] = useState<95 | 99>(95);
  const [varHorizonDays, setVarHorizonDays] = useState<1 | 10>(1);
  // Assumption overrides as raw text so an empty field stays "unset" (vs 0).
  const [waccPct, setWaccPct] = useState<string>("");
  const [terminalGrowthPct, setTerminalGrowthPct] = useState<string>("");
  const [growthOverridePct, setGrowthOverridePct] = useState<string>("");

  // Document attachment state. The list itself is owned by
  // DocumentVaultPanel (self-fetching); we only track which doc ids are
  // attached to this run + whether the panel is expanded.
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [showDocuments, setShowDocuments] = useState(false);

  // Reset state when modal opens. MONEY-457: the previous version also ran
  // a preflight checkAICreditsAction("advanced") and auto-closed the modal
  // (via onOpenChange(false)) if the user failed the gate. That created two
  // problems:
  //   1. Compare from screener showed a dialog flash then disappeared — the
  //      user perceived this as a disabled / broken Compare action.
  //   2. The preflight was hardcoded to "advanced" even when the user
  //      planned to pick Quick (Fast, 1 cr), locking out users with low
  //      credit balances who could have completed a cheaper run.
  // The submit-time credit check in handleStartResearch (line ~361) already
  // validates against the chosen mode and shows NoCreditDialog with the
  // correct reason. The modal can stay open until the user actually clicks
  // Start research.
  useEffect(() => {
    if (open) {
      setInstructions("");
      setIsSubmitting(false);
      setSelectedDocIds([]);
      setShowDocuments(false);
      setSkillsExpanded(false);
      setStyle((prefs?.researchStyle ?? "auto") as ResearchStyle);
      setCustomSkills(savedSkills);
      // MONEY-801 — reset run-params to their unset/default state each open so
      // they never leak across runs (behaviour-neutral defaults).
      setParamsExpanded(false);
      setHorizon(undefined);
      setBenchmark("");
      setReportLength("standard");
      setVarConfidence(95);
      setVarHorizonDays(1);
      setWaccPct("");
      setTerminalGrowthPct("");
      setGrowthOverridePct("");
    }
  }, [open, prefs?.researchStyle, savedSkills]);

  // Sync custom skills when style changes - picking a non-custom style applies
  // its preset bundle as the next-run skill set.
  useEffect(() => {
    const presetId = styleToPresetId(style);
    if (presetId) {
      setCustomSkills([...RESEARCH_PRESET_DEFS[presetId].defaultSkills]);
    }
  }, [style]);

  const toggleDocSelection = (docId: string) => {
    setSelectedDocIds((prev) =>
      prev.includes(docId)
        ? prev.filter((id) => id !== docId)
        : [...prev, docId]
    );
  };

  const toggleSkill = (id: ResearchSkillId) => {
    setCustomSkills((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleStartResearch = async () => {
    // MONEY-394 K - compare mode handles its own gate (length >= 2).
    if (!isCompareMode && !entity) return;
    setIsSubmitting(true);

    // Persist style + skills choice for next time
    void save({
      researchStyle: style,
      customSkills,
    });

    const mode = styleToMode(style);
    const creditCheck = await checkAICreditsAction(
      mode === "fast" ? "fast" : "advanced"
    );
    if (!creditCheck.allowed) {
      setIsSubmitting(false);
      setNoCreditReason(creditCheck.reason === "free" ? "free" : "no_credits");
      setNoCreditDialogOpen(true);
      return;
    }

    try {
      let query: string;
      let symbols: string[];
      let skillHint: string | undefined;

      if (isCompareMode) {
        // Comparison flow - `Compare A vs B vs …` query, peer-comparison
        // skill, all symbols passed through. The first entity drives the
        // label format; subsequent entities are concatenated.
        const labels = compareEntities!.map((e) =>
          e.type === "mf" || e.type === "etf" ? e.name || e.symbol : e.symbol
        );
        query = `Compare ${labels.join(" vs ")}`;
        symbols = compareEntities!.map((e) => e.symbol);
        skillHint = "peer-comparison";
      } else if (entity!.type === "etf") {
        query = `[ETF] ${entity!.name || entity!.symbol}`;
        symbols = [entity!.symbol];
      } else if (entity!.type === "mf") {
        query = `[MUTUAL_FUND] ${entity!.name}`;
        symbols = [entity!.symbol];
      } else {
        query = `Analyze ${entity!.symbol}${entity!.name ? ` (${entity!.name})` : ""}`;
        symbols = [entity!.symbol];
      }

      if (positionData && !isCompareMode) {
        const parts: string[] = [];
        if (positionData.status === "open") {
          parts.push(
            `Holding: ${positionData.quantity} units @ ₹${positionData.purchasePrice.toFixed(2)} (bought ${positionData.purchaseDate})`,
            `Current: ₹${(positionData.currentPrice ?? 0).toFixed(2)}`,
            `Unrealized P&L: ₹${(positionData.unrealizedPnL ?? 0).toFixed(2)}`,
            `Assess whether this was a good purchase and if the holding thesis still holds. Do NOT suggest buy or sell.`
          );
        } else {
          parts.push(
            `Closed position: ${positionData.quantity} units`,
            `Bought @ ₹${positionData.purchasePrice.toFixed(2)} on ${positionData.purchaseDate}`,
            `Sold @ ₹${(positionData.sellPrice ?? 0).toFixed(2)} on ${positionData.sellDate ?? ""}`,
            `Realized P&L: ₹${(positionData.realizedPnL ?? 0).toFixed(2)}`,
            `Evaluate the trade quality and timing. Do NOT suggest buy or sell.`
          );
        }
        query += ` | ${parts.join(", ")}`;
      }

      if (instructions.trim()) {
        query += ` | Instructions: ${instructions.trim()}`;
      }
      // MONEY-396 (Document Vault) - pinned docs are forwarded as a STRUCTURED
      // extra (`pinnedUserDocumentIds`) below, NOT stuffed into the query text.
      // The worker retrieves their embedded chunks (scoped to this user) and
      // cites them as primary-source evidence; the planner no longer sees a
      // noisy `[ATTACHED_DOCUMENTS:…]` token polluting the query string.

      const presetId = styleToPresetId(style);
      // MONEY-446 — a single-fund MF run must route to the `mf-analysis`
      // skill. The `[MUTUAL_FUND] …` query text doesn't match that skill's
      // matchSkill() triggers, so we pass `assetType: "mf"` which forces the
      // skill server-side and bills via the `mf_analysis` credit estimate.
      // Compare mode + stock + ETF are unaffected.
      const isMfRun = !isCompareMode && entity?.type === "mf";

      // MONEY-803a (C1a on the modal path) — resolve the effective skills to
      // send so a non-custom preset run (Comprehensive / Advanced …) no longer
      // drops its preset skill pack (the chat route already does this). For
      // Custom, send the user's hand-picked list; for any other style, send
      // the preset's effective skills so the worker receives the full pack
      // instead of `undefined`. Auto (no preset) resolves to none → undefined
      // so the planner keeps choosing depth at runtime.
      //
      // MONEY-806 — but a NON-custom MF preset run must NOT ship the stock skill
      // pack (DCF / quant-factor / VaR …). The worker forces the `mf-analysis`
      // skill via `assetType: "mf"`, so those stock skills only produced empty
      // sections while still billing their compute cost. Send `undefined` for a
      // non-custom MF run (the forced MF skill stands); a Custom run keeps the
      // user's explicit hand-picked list, and stock / ETF / compare are
      // unchanged.
      const effectiveSkills =
        style === "custom"
          ? customSkills
          : isMfRun
            ? []
            : resolveEffectiveSkills({ preset: presetId });
      const customSkillsExtra =
        effectiveSkills.length > 0 ? effectiveSkills : undefined;

      // MONEY-801 — institutional run-parameters. Each is forwarded only when
      // the user changed it from its behaviour-neutral default, so an untouched
      // run produces a byte-identical plan + report to before.
      const runParams = buildRunParamsExtras({
        horizon,
        benchmark,
        reportLength,
        varConfidence,
        varHorizonDays,
        waccPct,
        terminalGrowthPct,
        growthOverridePct,
      });

      const result = await startResearchAction(
        query,
        skillHint,
        symbols,
        mode ?? "advanced",
        undefined,
        {
          customSkills: customSkillsExtra,
          preset: presetId,
          ...(isMfRun ? { assetType: "mf" as const } : {}),
          // MONEY-396 (Document Vault) - pin the user's selected vault docs so
          // the worker grounds + cites the report in their own documents.
          ...(selectedDocIds.length > 0
            ? { pinnedUserDocumentIds: selectedDocIds }
            : {}),
          ...runParams,
        }
      );

      if (result?.success && result.sessionId) {
        toast.success("Research started");
        router.push(`/analysis/${result.sessionId}`);
        onOpenChange(false);
      } else {
        toast.error(result?.error || "Failed to start research");
      }
    } catch {
      toast.error("Failed to start research");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Model picker - read from composerPrefs. Plan gating is enforced
  // server-side in research.ts (line 234-237), so we just trust whatever
  // the user has saved and fall back to gemini-2.5-flash (universally
  // available) when nothing is stored. The picker dropdown shows every
  // available Gemini model - the action will resolve to a permitted one
  // if the saved choice is outside the user's plan.
  // MONEY-1274 (#27) — Claude is plan-gated now, not allowlist-only, so the
  // picker needs the plan. `planId` defaults to "FREE" while the access fetch
  // is in flight (see the MONEY-457 note above), which means a Claude entry
  // appears a beat late for an entitled user rather than a forbidden one
  // appearing early — the safe direction for a paid model.
  const availableModels = getPickerModelsForUser(
    user?.primaryEmailAddress?.emailAddress,
    planId
  );
  const storedModel = composerPrefs?.model ?? null;
  const selectedModelId =
    storedModel &&
    availableModels.find((m: ModelDefinition) => m.id === storedModel)
      ? storedModel
      : "gemini-2.5-flash";
  const selectedModel = availableModels.find(
    (m: ModelDefinition) => m.id === selectedModelId
  );

  const styleAccent = STYLES.find((s) => s.id === style)?.accent ?? "#34d399";

  // MONEY-801 — count of run-params the user has moved off their default, used
  // for the section's badge + summary copy. Mirrors buildRunParamsExtras's
  // omit-when-default logic so the badge and the forwarded extras agree.
  const activeParamCount = Object.keys(
    buildRunParamsExtras({
      horizon,
      benchmark,
      reportLength,
      varConfidence,
      varHorizonDays,
      waccPct,
      terminalGrowthPct,
      growthOverridePct,
    })
  ).length;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="text-foreground p-0 overflow-hidden"
          style={{
            // Inline width wins over the dialog primitive's `max-w-lg`
            // since arbitrary-value class precedence isn't reliable
            // through twMerge for the `!max-w-[…]` syntax. Pinning the
            // width here also stops the 2-col Research Style grid from
            // overflowing the modal's right edge.
            maxWidth: "460px",
            width: "calc(100vw - 24px)",
            background: "var(--paper)",
            color: "var(--ink)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "var(--shadow-hard)",
          }}
        >
          {/* Accessible name for screen readers — the visible header below is
              an icon + entity layout, so we provide a concise sr-only title. */}
          <DialogTitle className="sr-only">Research options</DialogTitle>
          {/* Header - Brain icon + entity (or 'Compare N stocks' when
              compareEntities is provided per MONEY-394 K) */}
          <div
            className="px-5 py-3.5 flex items-center gap-2.5"
            style={{
              borderBottom: "2px solid var(--ink)",
              background: "var(--paper-2)",
            }}
          >
            <span
              className="w-8 h-8 rounded-lg grid place-items-center"
              style={{
                background: `${styleAccent}15`,
                border: `1px solid ${styleAccent}30`,
                color: styleAccent,
              }}
            >
              <Brain className="h-4 w-4" />
            </span>
            <div className="flex-1 min-w-0 pr-8">
              {isCompareMode ? (
                <>
                  <div
                    className="font-display text-[14.5px] font-bold tracking-[-0.2px] truncate"
                    style={{ color: "var(--ink)" }}
                  >
                    Compare {compareEntities!.length} stocks
                  </div>
                  <div
                    className="font-mono text-[10.5px] uppercase tracking-[1px] leading-[1.4]"
                    style={{
                      color: "var(--ink-3)",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                    title={compareEntities!.map((e) => e.symbol).join(" vs ")}
                  >
                    {compareEntities!.map((e) => e.symbol).join(" · ")}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className="font-display text-[14.5px] font-bold tracking-[-0.2px] truncate"
                    style={{ color: "var(--ink)" }}
                    title={entity?.name || entity?.symbol || ""}
                  >
                    Analyze {entity?.symbol || ""}
                  </div>
                  {entity ? (
                    <div
                      className="font-mono text-[10.5px] uppercase tracking-[1px] leading-[1.4]"
                      title={entity.name}
                      style={{
                        color: "var(--ink-3)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {clampName(entity.name)}
                      {entity.exchange ? ` · ${entity.exchange}` : ""}
                      {` · ${entity.type.toUpperCase()}`}
                    </div>
                  ) : (
                    <div
                      className="font-mono text-[10.5px] uppercase tracking-[1px]"
                      style={{ color: "var(--ink-3)" }}
                    >
                      Pick an instrument
                    </div>
                  )}
                </>
              )}
            </div>
            {/* Close X is rendered by the Dialog primitive (top-right
                absolute) - don't add a second one here. */}
          </div>

          <div
            className="max-h-[70vh] overflow-y-auto space-y-4"
            style={{ padding: "18px 22px" }}
          >
            {/* Position pre-data - passed from holdings/positions/tradebook */}
            {positionData && (
              <div
                style={{
                  borderRadius: 10,
                  background: "var(--emerald-bg)",
                  border: "1px solid var(--emerald)",
                  padding: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "1.5px",
                      color: "var(--emerald-text)",
                      textTransform: "uppercase",
                    }}
                  >
                    Holding context
                  </span>
                  <span
                    className="pf-pill"
                    style={{
                      fontSize: 9.5,
                      background:
                        positionData.status === "open"
                          ? "var(--emerald)"
                          : "var(--rule-soft)",
                      color:
                        positionData.status === "open"
                          ? "var(--paper)"
                          : "var(--ink-3)",
                      borderColor:
                        positionData.status === "open"
                          ? "var(--emerald)"
                          : "var(--rule-soft)",
                    }}
                  >
                    {positionData.status === "open" ? "OPEN" : "CLOSED"}
                  </span>
                </div>
                <div
                  className="mono"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    columnGap: 16,
                    rowGap: 2,
                    fontSize: 11.5,
                  }}
                >
                  <span style={{ color: "var(--ink-3)" }}>Qty</span>
                  <span style={{ textAlign: "right", color: "var(--ink)" }}>
                    {positionData.quantity}
                  </span>
                  <span style={{ color: "var(--ink-3)" }}>Buy</span>
                  <span style={{ textAlign: "right", color: "var(--ink)" }}>
                    ₹{positionData.purchasePrice.toFixed(2)}
                  </span>
                  {positionData.status === "open" ? (
                    <>
                      <span style={{ color: "var(--ink-3)" }}>LTP</span>
                      <span style={{ textAlign: "right", color: "var(--ink)" }}>
                        ₹{(positionData.currentPrice ?? 0).toFixed(2)}
                      </span>
                      <span style={{ color: "var(--ink-3)" }}>P/L</span>
                      <span
                        style={{
                          textAlign: "right",
                          fontWeight: 700,
                          color:
                            (positionData.unrealizedPnL ?? 0) >= 0
                              ? "var(--emerald-text)"
                              : "var(--pop-1-text)",
                        }}
                      >
                        {(positionData.unrealizedPnL ?? 0) >= 0 ? "+" : ""}₹
                        {(positionData.unrealizedPnL ?? 0).toFixed(2)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ color: "var(--ink-3)" }}>Sell</span>
                      <span style={{ textAlign: "right", color: "var(--ink)" }}>
                        ₹{(positionData.sellPrice ?? 0).toFixed(2)}
                      </span>
                      <span style={{ color: "var(--ink-3)" }}>Realised</span>
                      <span
                        style={{
                          textAlign: "right",
                          fontWeight: 700,
                          color:
                            (positionData.realizedPnL ?? 0) >= 0
                              ? "var(--emerald-text)"
                              : "var(--pop-1-text)",
                        }}
                      >
                        {(positionData.realizedPnL ?? 0) >= 0 ? "+" : ""}₹
                        {(positionData.realizedPnL ?? 0).toFixed(2)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Model + Docs toolbar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "1.5px",
                }}
              >
                Model
              </span>
              <ModelChip
                modelId={selectedModelId}
                modelName={
                  selectedModel?.displayName.replace(/^Gemini /, "") ??
                  selectedModelId
                }
                provider={selectedModel?.provider ?? "google"}
                onChange={(id) => void saveComposer({ model: id })}
              />
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="pf-bf sm"
                style={{ fontSize: 11.5, padding: "4px 10px" }}
                onClick={() => setShowDocuments((v) => !v)}
              >
                <Paperclip className="h-3 w-3" />
                Docs
                {selectedDocIds.length > 0 && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--emerald-text)",
                      fontWeight: 800,
                    }}
                  >
                    {selectedDocIds.length}
                  </span>
                )}
              </button>
            </div>

            {/* Style picker - 6 options as compact cards */}
            <div>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "1.5px",
                  marginBottom: 8,
                }}
              >
                Research style
              </div>
              <div className="grid grid-cols-2 gap-1.5 min-w-0">
                {STYLES.map((s) => {
                  const active = s.id === style;
                  const locked = isFreePlan && PRO_ONLY_STYLES.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleStyleClick(s.id)}
                      className="min-w-0 w-full text-left p-2 rounded-lg border transition-colors flex items-start gap-2"
                      style={{
                        background: active
                          ? `${s.accent}10`
                          : "rgba(255,255,255,0.025)",
                        borderColor: active
                          ? `${s.accent}40`
                          : "rgba(255,255,255,0.06)",
                        opacity: locked ? 0.55 : 1,
                      }}
                    >
                      <span
                        className="w-7 h-7 rounded-md grid place-items-center shrink-0"
                        style={{
                          background: `${s.accent}15`,
                          color: s.accent,
                        }}
                      >
                        <s.Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[12.5px] font-semibold text-foreground truncate">
                            {s.label}
                          </span>
                          {locked && (
                            <span
                              className="font-mono text-[9.5px] font-bold tracking-[0.6px] uppercase px-1.5 py-[1px] rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shrink-0"
                              title="Upgrade to Pro to unlock"
                            >
                              Pro
                            </span>
                          )}
                          {active && !locked && (
                            <Check
                              className="h-3 w-3 shrink-0"
                              style={{ color: s.accent }}
                            />
                          )}
                        </div>
                        <div className="font-mono text-[9.5px] tracking-[0.4px] text-muted-foreground/80 mt-0.5 truncate">
                          {s.meta}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <p
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginTop: 6,
                  lineHeight: 1.4,
                  fontFamily: "Instrument Serif, serif",
                  fontStyle: "italic",
                }}
              >
                {STYLES.find((s) => s.id === style)?.blurb}
              </p>
            </div>

            {/* Skills section - always visible, collapsible */}
            <div>
              <button
                type="button"
                onClick={() => setSkillsExpanded((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  padding: 0,
                  color: "var(--ink)",
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "1.5px",
                  }}
                >
                  Skills
                </span>
                <span
                  className="pf-pill emerald"
                  style={{ fontSize: 9.5, padding: "2px 7px" }}
                >
                  <Wand2 className="h-2.5 w-2.5" />
                  {customSkills.length}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {style === "custom"
                    ? "Tap to pick what runs"
                    : `Preview of ${STYLES.find((s) => s.id === style)?.label} skills`}
                </span>
                <div style={{ flex: 1 }} />
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${skillsExpanded ? "rotate-180" : ""}`}
                  style={{ color: "var(--ink-3)" }}
                />
              </button>
              {skillsExpanded && (
                <div className="mt-2">
                  <CustomSkillsChips
                    value={customSkills}
                    onToggle={(id) => {
                      // Picking a skill outside Custom → switch to Custom so
                      // the run uses the user's edited bundle, not the preset.
                      if (style !== "custom") setStyle("custom");
                      toggleSkill(id);
                    }}
                  />
                </div>
              )}
            </div>

            {/* MONEY-801 — Run parameters: institutional knobs (horizon,
                benchmark, report length, VaR config, DCF assumptions). All
                default to behaviour-neutral, so an untouched run is unchanged. */}
            <div>
              <button
                type="button"
                onClick={() => setParamsExpanded((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  padding: 0,
                  color: "var(--ink)",
                }}
              >
                <SlidersHorizontal
                  className="h-3 w-3"
                  style={{ color: "var(--ink-3)" }}
                />
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "1.5px",
                  }}
                >
                  Run parameters
                </span>
                {activeParamCount > 0 && (
                  <span
                    className="pf-pill emerald"
                    style={{ fontSize: 9.5, padding: "2px 7px" }}
                  >
                    {activeParamCount}
                  </span>
                )}
                <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {activeParamCount > 0
                    ? "Custom horizon / benchmark / assumptions"
                    : "Defaults — tap to tune"}
                </span>
                <div style={{ flex: 1 }} />
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${paramsExpanded ? "rotate-180" : ""}`}
                  style={{ color: "var(--ink-3)" }}
                />
              </button>
              {paramsExpanded && (
                <div
                  className="mt-2 space-y-3"
                  style={{
                    padding: "12px",
                    borderRadius: 10,
                    border: "1.5px dashed var(--rule-soft)",
                    background: "var(--paper-2)",
                  }}
                >
                  {/* Horizon */}
                  <ParamRow label="Horizon" hint="Price-history window">
                    <SegmentedControl
                      options={[
                        { value: "", label: "Default" },
                        ...RESEARCH_HORIZONS.map((h) => ({
                          value: h,
                          label: h.toUpperCase(),
                        })),
                      ]}
                      value={horizon ?? ""}
                      onChange={(v) =>
                        setHorizon(
                          v === "" ? undefined : (v as ResearchHorizon)
                        )
                      }
                    />
                  </ParamRow>

                  {/* Benchmark. The schema also accepts a free-text sector
                      name, but there is no text field here, so the picker
                      exposes the three enum-backed indices; "" = default ^NSEI
                      (NIFTY 50). */}
                  <ParamRow label="Benchmark" hint="Beta / relative framing">
                    <SegmentedControl
                      options={[
                        { value: "", label: "NIFTY 50" },
                        ...RESEARCH_BENCHMARKS.filter(
                          (b) => b !== "NIFTY50"
                        ).map((b) => ({ value: b, label: b })),
                      ]}
                      value={
                        (RESEARCH_BENCHMARKS as readonly string[]).includes(
                          benchmark
                        ) && benchmark !== "NIFTY50"
                          ? benchmark
                          : ""
                      }
                      onChange={(v) => setBenchmark(v)}
                    />
                  </ParamRow>

                  {/* Report length */}
                  <ParamRow label="Report length" hint="Synthesis depth">
                    <SegmentedControl
                      options={RESEARCH_REPORT_LENGTHS.map((r) => ({
                        value: r,
                        label: r.charAt(0).toUpperCase() + r.slice(1),
                      }))}
                      value={reportLength}
                      onChange={(v) =>
                        setReportLength(v as ResearchReportLength)
                      }
                    />
                  </ParamRow>

                  {/* VaR config */}
                  <ParamRow label="VaR" hint="Confidence · holding days">
                    <div className="flex items-center gap-2">
                      <SegmentedControl
                        options={[
                          { value: "95", label: "95%" },
                          { value: "99", label: "99%" },
                        ]}
                        value={String(varConfidence)}
                        onChange={(v) =>
                          setVarConfidence(Number(v) === 99 ? 99 : 95)
                        }
                      />
                      <SegmentedControl
                        options={[
                          { value: "1", label: "1d" },
                          { value: "10", label: "10d" },
                        ]}
                        value={String(varHorizonDays)}
                        onChange={(v) =>
                          setVarHorizonDays(Number(v) === 10 ? 10 : 1)
                        }
                      />
                    </div>
                  </ParamRow>

                  {/* DCF / WACC assumptions */}
                  <div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        color: "var(--ink-3)",
                        textTransform: "uppercase",
                        letterSpacing: "1.2px",
                        marginBottom: 6,
                      }}
                    >
                      Assumptions{" "}
                      <span style={{ opacity: 0.55 }}>(% · optional)</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <PctInput
                        label="WACC"
                        value={waccPct}
                        onChange={setWaccPct}
                        placeholder="11"
                      />
                      <PctInput
                        label="Term. growth"
                        value={terminalGrowthPct}
                        onChange={setTerminalGrowthPct}
                        placeholder="4"
                      />
                      <PctInput
                        label="Growth"
                        value={growthOverridePct}
                        onChange={setGrowthOverridePct}
                        placeholder="12"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Instructions textarea */}
            <div>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "1.5px",
                  marginBottom: 6,
                }}
              >
                Instructions <span style={{ opacity: 0.55 }}>(optional)</span>
              </div>
              <textarea
                placeholder="Focus on risk analysis, compare valuations…"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={2}
                maxLength={500}
                className="pf-input"
                style={{ resize: "none", fontSize: 13 }}
              />
            </div>

            {/* Documents picker - vault-style panel (search + typed list +
                upload). Selection stays in `selectedDocIds` (real string ids)
                which the start handler forwards as the structured
                `pinnedUserDocumentIds` extra (MONEY-396) so the worker cites
                them. Only READY (indexed) docs are attachable; a freshly-
                uploaded doc auto-selects so it attaches once it finishes
                processing. */}
            {showDocuments && (
              <DocumentVaultPanel
                selectedIds={selectedDocIds}
                onToggle={toggleDocSelection}
                onlyReady
                listMaxHeight={160}
                onUploaded={(docId) =>
                  setSelectedDocIds((prev) =>
                    prev.includes(docId) ? prev : [...prev, docId]
                  )
                }
              />
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              padding: "14px 22px",
              borderTop: "1.5px dashed var(--rule-soft)",
              background: "var(--paper-2)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 10.5, color: "var(--ink-3)" }}
            >
              {STYLES.find((s) => s.id === style)?.meta}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={handleStartResearch}
              /* MONEY-457: in compare mode entity is intentionally null
                 (the modal uses compareEntities instead). The previous
                 `!entity` check disabled the button for every compare
                 flow, regardless of how many stocks were picked. */
              disabled={
                isSubmitting ||
                (isCompareMode ? (compareEntities?.length ?? 0) < 2 : !entity)
              }
              className="pf-bs sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Brain className="h-3.5 w-3.5" />
              )}
              Start research
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <NoCreditDialog
        open={noCreditDialogOpen}
        onOpenChange={setNoCreditDialogOpen}
        reason={noCreditReason}
      />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

// MONEY-801 — run-parameter controls. A labelled row + a compact segmented
// control + a percentage text input, all in the playful ink/paper idiom.

function ParamRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="min-w-0" style={{ width: 92 }}>
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: "var(--ink)",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          {label}
        </div>
        {hint && (
          <div style={{ fontSize: 9.5, color: "var(--ink-3)", marginTop: 1 }}>
            {hint}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex justify-end">{children}</div>
    </div>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div
      className="inline-flex items-center"
      style={{
        borderRadius: 8,
        border: "1.5px solid var(--rule-soft)",
        overflow: "hidden",
        background: "var(--paper)",
      }}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              padding: "4px 9px",
              cursor: "pointer",
              border: 0,
              borderLeft: i === 0 ? 0 : "1.5px solid var(--rule-soft)",
              background: active ? "var(--emerald)" : "transparent",
              color: active ? "var(--paper)" : "var(--ink-3)",
              letterSpacing: "0.4px",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function PctInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block min-w-0">
      <span
        className="mono block"
        style={{
          fontSize: 9,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.6px",
          marginBottom: 3,
        }}
      >
        {label}
      </span>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pf-input mono"
          style={{ fontSize: 12, padding: "5px 18px 5px 8px", width: "100%" }}
        />
        <span
          className="mono absolute"
          style={{
            right: 7,
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: 10,
            color: "var(--ink-3)",
            pointerEvents: "none",
          }}
        >
          %
        </span>
      </div>
    </label>
  );
}

function ModelChip({
  modelId,
  modelName,
  provider,
  onChange,
}: {
  modelId: string;
  modelName: string;
  provider: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { user } = useUser();
  // MONEY-1274 (#27) — Claude is plan-gated now, so this picker needs the plan
  // too. Read here rather than threaded as a prop: ModelChip is rendered from
  // more than one place and a prop would let a caller forget it, which would
  // silently show a FREE user a model they cannot resolve.
  const { planId } = useSubscriptionAccess(false);
  const models = getPickerModelsForUser(
    user?.primaryEmailAddress?.emailAddress,
    planId
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border bg-white/[0.04] border-white/[0.06] text-[11.5px] font-medium text-foreground/85 hover:bg-white/[0.06]"
      >
        <span
          className="grid place-items-center shrink-0"
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            background: "var(--paper)",
            border: "1px solid var(--rule-soft)",
            overflow: "hidden",
          }}
        >
          <ModelBrandMark family={providerToFamily(provider)} size={11} />
        </span>
        {modelName}
        <ChevronDown
          className={`h-3 w-3 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          className="absolute left-0 top-9 z-50 min-w-[240px] rounded-xl p-1"
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            boxShadow: "4px 4px 0 var(--ink)",
          }}
        >
          {models.map((m: ModelDefinition) => {
            const active = m.id === modelId;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className="w-full text-left px-2 py-1.5 rounded-md hover:bg-emerald-500/[0.06] flex items-center gap-2"
              >
                <span
                  className="grid place-items-center shrink-0"
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 6,
                    background: "var(--paper)",
                    border: "1px solid var(--rule-soft)",
                    overflow: "hidden",
                  }}
                >
                  <ModelBrandMark
                    family={providerToFamily(m.provider)}
                    size={13}
                  />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-foreground font-medium truncate">
                    {m.displayName}
                  </div>
                  {m.description && (
                    <div className="text-[10.5px] text-muted-foreground truncate">
                      {m.description}
                    </div>
                  )}
                </div>
                {active && (
                  <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Mirror SKILL_ROWS from the chat composer popover so the skill rows
// look identical to the "+ icon" experience users already know.
type SkillGroup = "fundamentals" | "quant" | "macro" | "risk-news";

interface SkillRow {
  id: ResearchSkillId;
  Icon: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  group: SkillGroup;
}

const SKILL_ROWS: SkillRow[] = [
  // Fundamentals + valuation
  { id: "fundamentals-core", Icon: BarChart3, group: "fundamentals" },
  { id: "cash-flow-quality", Icon: Activity, group: "fundamentals" },
  { id: "earnings-deep-dive", Icon: TrendingUp, group: "fundamentals" },
  { id: "dcf-valuation", Icon: Target, group: "fundamentals" },
  { id: "dividend-income", Icon: PieChart, group: "fundamentals" },
  { id: "relative-valuation", Icon: Users, group: "fundamentals" },
  // MONEY-793 (C1b): promoted orphan packs (fundamentals).
  { id: "mf-deep-dive", Icon: Layers, group: "fundamentals" },
  { id: "forensic-accounting", Icon: Microscope, group: "fundamentals" },
  // Quant / technical
  { id: "quant-factor-scores", Icon: Sparkles, group: "quant" },
  { id: "technical-trend", Icon: Waves, group: "quant" },
  { id: "chart-pattern-detection", Icon: LineChart, group: "quant" },
  { id: "regime-volatility", Icon: ShieldAlert, group: "quant" },
  // Macro & flows
  { id: "macro-sensitivities", Icon: Globe, group: "macro" },
  { id: "flows-and-positioning", Icon: Activity, group: "macro" },
  // MONEY-793 (C1b): composed + promoted orphan packs (macro).
  { id: "theme-evaluation", Icon: Layers, group: "macro" },
  { id: "global-funds", Icon: Globe, group: "macro" },
  // Forward + risk + governance + sentiment
  { id: "forward-scenarios", Icon: TrendingUp, group: "risk-news" },
  { id: "risk-portfolio-impact", Icon: ShieldAlert, group: "risk-news" },
  // MONEY-669: L4-only VaR/stress pack (default-on for L4 Institutional).
  { id: "risk-var-stress", Icon: ShieldAlert, group: "risk-news" },
  { id: "governance-flags", Icon: FolderOpen, group: "risk-news" },
  { id: "news-sentiment-catalysts", Icon: FileText, group: "risk-news" },
  // MONEY-793 (C1b): composed + promoted orphan packs (risk-news).
  { id: "portfolio-impact-on-user", Icon: PieChart, group: "risk-news" },
  { id: "catalyst-calendar", Icon: Activity, group: "risk-news" },
  { id: "tax-planning", Icon: FileText, group: "risk-news" },
];

const SKILL_GROUP_LABELS: Record<SkillGroup, string> = {
  fundamentals: "Fundamentals & valuation",
  quant: "Quant & technical",
  macro: "Macro & flows",
  "risk-news": "Risk · governance · sentiment",
};

function CustomSkillsChips({
  value,
  onToggle,
}: {
  value: ResearchSkillId[];
  onToggle: (id: ResearchSkillId) => void;
}) {
  const groupedRows = SKILL_ROWS.reduce<Record<SkillGroup, SkillRow[]>>(
    (acc, row) => {
      (acc[row.group] ||= []).push(row);
      return acc;
    },
    {} as Record<SkillGroup, SkillRow[]>
  );

  return (
    <div
      className="rounded-xl border bg-popover/50 backdrop-blur-sm overflow-hidden"
      style={{ borderColor: "rgba(52,211,153,0.15)" }}
    >
      <div className="px-1.5 pt-1.5 pb-1.5 max-h-[240px] overflow-y-auto">
        {(["fundamentals", "quant", "macro", "risk-news"] as const).map(
          (group) => (
            <div key={group}>
              <div
                className="font-mono uppercase font-bold mt-1 mb-0.5"
                style={{
                  padding: "4px 10px",
                  fontSize: 9.5,
                  letterSpacing: 1.5,
                  color: "var(--ink-3)",
                }}
              >
                {SKILL_GROUP_LABELS[group]}
              </div>
              {(groupedRows[group] ?? []).map((row) => {
                const on = value.includes(row.id);
                const Icon = row.Icon;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => onToggle(row.id)}
                    title={RESEARCH_SKILL_DESCRIPTIONS[row.id]}
                    className="w-full flex items-center gap-2.5 mb-0.5 text-left"
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      cursor: "pointer",
                      background: on ? "var(--emerald-bg)" : "transparent",
                      border: 0,
                      color: "var(--ink)",
                    }}
                  >
                    <span
                      className="grid place-items-center shrink-0"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        background: on ? "var(--emerald)" : "transparent",
                        border: `1.5px solid ${on ? "var(--emerald)" : "var(--rule-soft)"}`,
                        color: "#16140e",
                      }}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    <Icon
                      className="h-3.5 w-3.5"
                      style={{
                        color: on ? "var(--emerald-text)" : "var(--ink-3)",
                      }}
                    />
                    <span className="text-[12.5px] flex-1 font-medium">
                      {RESEARCH_SKILL_LABELS[row.id]}
                    </span>
                  </button>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}
