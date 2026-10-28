"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePfConfirm } from "@/components/ui/use-confirm";
import { resetMyComposerPreferencesAction } from "@/lib/actions/preferences";
import { Popover, PopoverContent, PopoverTrigger } from "@usemoney/ui/popover";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Book,
  Check,
  ChevronRight,
  Code,
  FileText,
  Filter,
  FolderOpen,
  Atom,
  Globe,
  HelpCircle,
  Layers,
  LineChart,
  Link2,
  Microscope,
  MoreVertical,
  Pencil,
  PieChart,
  Pin,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Star,
  Target,
  Trash2,
  TrendingUp,
  UserCog,
  Users,
  Wand2,
  Waves,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useResearchPreferences } from "@/hooks/useResearchPreferences";
import { useComposerPreferences } from "@/hooks/useComposerPreferences";
import { useSubscriptionAccess } from "@/hooks/useSubscriptionAccess";
import { useChatContext } from "@/lib/chat/ChatContext";
import { toast } from "sonner";
import {
  getBrokerConnectionsAction,
  syncBrokerDataAction,
  disconnectBrokerAction,
  getOAuthUrlAction,
} from "@/lib/actions/broker-connection";
import { getDocumentsAction } from "@/lib/actions/documents";
import {
  DocumentVaultPanel,
  type VaultDocument,
} from "@/components/documents/DocumentVaultPanel";
import {
  richSearchInstrumentsAction,
  type RichSearchStockResult,
  type RichSearchMfResult,
} from "@/lib/actions/discover";
import {
  RESEARCH_SKILL_LABELS,
  RESEARCH_SKILL_DESCRIPTIONS,
  RESEARCH_PRESET_DEFS,
  RESEARCH_HORIZONS,
  RESEARCH_BENCHMARKS,
  RESEARCH_REPORT_LENGTHS,
  expandSkillAliases,
  type ResearchSkillId,
  type ResearchStyle,
  type ResearchPresetId,
  type ResearchHorizon,
  type ResearchReportLength,
  type ResearchVarConfig,
  type ResearchAssumptions,
  type ResearchPreferencesInput,
} from "@usemoney/services/preferences";

/**
 * StockSage "+" popover - chat composer entry point for every research
 * preference, source, and tool the agent uses. Three sections (Research
 * preferences / Sources / Tools) plus a separate Model picker live here.
 *
 * Implements the Claude Design redesign for MONEY-219 → MONEY-225, with
 * real persistence wired to `User.preferences.research` for style /
 * skills / focus and local-only state for the new sources + tools rows
 * (which land in their own follow-up tickets).
 */

// ─── Static data (mirrors design bundle's data.jsx) ─────────────────────

interface StyleOption {
  id: ResearchStyle;
  name: string;
  Icon: LucideIcon;
  tier?: "L1" | "L2" | "L3" | "L4";
  blurb: string;
  time: string;
  credits: string;
  accent: string;
}

const STYLES: StyleOption[] = [
  {
    id: "auto",
    name: "Auto",
    Icon: Sparkles,
    blurb: "StockSage picks plan depth from the question.",
    time: "~1 min",
    credits: "1 cr",
    accent: "var(--emerald)",
  },
  {
    id: "quick",
    name: "Quick",
    Icon: Zap,
    tier: "L1",
    blurb: "Fundamentals snapshot + last 4 quarters.",
    time: "~30 s",
    credits: "1 cr",
    accent: "#fbbf24",
  },
  {
    id: "deep",
    name: "Deep",
    Icon: Microscope,
    tier: "L2",
    blurb: "Multi-step research + peer + macro context.",
    time: "~3 min",
    credits: "4 cr",
    accent: "#a78bfa",
  },
  {
    id: "comprehensive",
    name: "Comprehensive",
    Icon: Layers,
    tier: "L3",
    blurb:
      "Deep + governance + sentiment + scenarios across 13 institutional skills.",
    time: "~6 min",
    credits: "6 cr",
    accent: "#34d399",
  },
  {
    id: "advanced",
    name: "Advanced",
    Icon: Atom,
    tier: "L4",
    blurb:
      "Comprehensive + quant factors + chart patterns + custom strategies.",
    time: "~12 min",
    credits: "12 cr",
    accent: "#f97316",
  },
  {
    id: "custom",
    name: "Custom",
    Icon: Wand2,
    blurb: "Run only the skills you've pinned below.",
    time: "varies",
    credits: "-",
    accent: "#3b82f6",
  },
];

interface SkillRow {
  id: ResearchSkillId;
  Icon: LucideIcon;
  group: "fundamentals" | "quant" | "macro" | "risk-news";
}

/**
 * MONEY-219 v2 - 16 institutional-grade skills grouped into 4 sections.
 * v1 alias IDs (`investment-thesis`, `peer-comparison`, etc.) are kept
 * in the type union for back-compat but NOT shown in the picker. They
 * auto-expand to v2 IDs at the planner via `expandSkillAliases`.
 */
const SKILL_ROWS: SkillRow[] = [
  // ── Fundamentals + valuation ────────────────────────────────────
  { id: "fundamentals-core", Icon: BarChart3, group: "fundamentals" },
  { id: "cash-flow-quality", Icon: Activity, group: "fundamentals" },
  { id: "earnings-deep-dive", Icon: TrendingUp, group: "fundamentals" },
  { id: "dcf-valuation", Icon: Target, group: "fundamentals" },
  { id: "dividend-income", Icon: PieChart, group: "fundamentals" },
  { id: "relative-valuation", Icon: Users, group: "fundamentals" },
  // MONEY-793 (C1b): promoted orphan packs (fundamentals).
  { id: "mf-deep-dive", Icon: Layers, group: "fundamentals" },
  { id: "forensic-accounting", Icon: Microscope, group: "fundamentals" },
  // ── Quant / technical ───────────────────────────────────────────
  { id: "quant-factor-scores", Icon: Sparkles, group: "quant" },
  { id: "technical-trend", Icon: Waves, group: "quant" },
  { id: "chart-pattern-detection", Icon: LineChart, group: "quant" },
  { id: "regime-volatility", Icon: ShieldAlert, group: "quant" },
  // ── Macro & flows ───────────────────────────────────────────────
  { id: "macro-sensitivities", Icon: Globe, group: "macro" },
  { id: "flows-and-positioning", Icon: Activity, group: "macro" },
  // MONEY-793 (C1b): composed + promoted orphan packs (macro).
  { id: "theme-evaluation", Icon: Layers, group: "macro" },
  { id: "global-funds", Icon: Globe, group: "macro" },
  // ── Forward + risk + governance + sentiment ─────────────────────
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

const SKILL_GROUP_LABELS: Record<SkillRow["group"], string> = {
  fundamentals: "Fundamentals & valuation",
  quant: "Quant & technical",
  macro: "Macro & flows",
  "risk-news": "Risk · governance · sentiment",
};

/**
 * Quick-pick preset chips. Custom is omitted - clearing all picked
 * skills is the same as Custom. Comprehensive shows the "go big" path.
 */
const PRESET_CHIPS: ResearchPresetId[] = [
  "quick-pulse",
  "investment-thesis",
  "quant-deep-dive",
  "earnings-preview",
  "macro-sector-view",
  "risk-audit",
  "comprehensive",
  "l4-institutional",
];

const FOCUS_QUICK_ADDS = [
  "India-listed only",
  "Margin expansion",
  "Net-debt < 1×",
  "ROE > 15%",
  "FII pickup",
];

const FOCUS_MAX = 280;

// Mock broker accounts - wired to real /brokers data in a follow-up.
interface BrokerAccount {
  id: string;
  platform: string;
  platformLabel: string;
  nickname: string;
  status: "active" | "expired" | "never";
  meta: string;
  brand: string;
}

const BROKERS: BrokerAccount[] = [
  {
    id: "zerodha:personal",
    platform: "zerodha",
    platformLabel: "Zerodha",
    nickname: "Personal",
    status: "active",
    meta: "38 holdings · ₹12.4L",
    brand: "#387ed1",
  },
  {
    id: "zerodha:huf",
    platform: "zerodha",
    platformLabel: "Zerodha",
    nickname: "HUF",
    status: "active",
    meta: "12 holdings · ₹6.8L",
    brand: "#387ed1",
  },
  {
    id: "zerodha:wife",
    platform: "zerodha",
    platformLabel: "Zerodha",
    nickname: "Spouse",
    status: "expired",
    meta: "Last sync 6 d ago",
    brand: "#387ed1",
  },
  {
    id: "upstox:trading",
    platform: "upstox",
    platformLabel: "Upstox",
    nickname: "Trading",
    status: "active",
    meta: "14 holdings · ₹3.2L",
    brand: "#7b2ff7",
  },
  {
    id: "upstox:swing",
    platform: "upstox",
    platformLabel: "Upstox",
    nickname: "Swing",
    status: "active",
    meta: "5 holdings · ₹62.4K",
    brand: "#7b2ff7",
  },
  {
    id: "groww:main",
    platform: "groww",
    platformLabel: "Groww",
    nickname: "Main",
    status: "active",
    meta: "21 holdings · ₹2.1L",
    brand: "#5eb66e",
  },
  {
    id: "angel:main",
    platform: "angel",
    platformLabel: "Angel One",
    nickname: "Main",
    status: "active",
    meta: "9 holdings · ₹84.6K",
    brand: "#e85454",
  },
  {
    id: "dhan:fno",
    platform: "dhan",
    platformLabel: "Dhan",
    nickname: "F&O",
    status: "expired",
    meta: "Last sync 14 d ago",
    brand: "#f59e42",
  },
  {
    id: "fyers:main",
    platform: "fyers",
    platformLabel: "Fyers",
    nickname: "Main",
    status: "never",
    meta: "Never synced",
    brand: "#2196f3",
  },
];

// Instruments mock data
interface InstrumentItem {
  sym: string;
  name: string;
  px: string;
  chg: string;
  pos: boolean;
  pinned: boolean;
  recent: boolean;
  exchange?: string;
  sector?: string;
  mcap?: string;
  kind?: string;
  aum?: string;
  rating?: number;
  bench?: string;
  liquidity?: "High" | "Medium" | "Low";
  nav?: string;
}

interface DocItem {
  id: number;
  n: string;
  t: "pdf" | "csv" | "txt" | "xls" | "md";
  size: string;
  used: string;
}
const DOCS: DocItem[] = [
  {
    id: 1,
    n: "RELIANCE_AR_FY25.pdf",
    t: "pdf",
    size: "8.2 MB",
    used: "2 d ago",
  },
  {
    id: 2,
    n: "Q2-FY26-tradebook.csv",
    t: "csv",
    size: "412 KB",
    used: "1 h ago",
  },
  {
    id: 3,
    n: "ICICIBANK-concall.txt",
    t: "txt",
    size: "44 KB",
    used: "3 d ago",
  },
  {
    id: 4,
    n: "INDIA_CPI_series.xlsx",
    t: "xls",
    size: "1.1 MB",
    used: "8 d ago",
  },
  { id: 5, n: "BAJAJFINSV-thesis.md", t: "md", size: "12 KB", used: "5 h ago" },
  {
    id: 6,
    n: "FY25-NIFTY50-screener.csv",
    t: "csv",
    size: "203 KB",
    used: "12 d ago",
  },
];

interface IndicatorRow {
  id: string;
  n: string;
  fam: "Trend" | "Momentum" | "Volatility" | "Volume" | "Strength";
  gated: boolean;
}
const INDICATORS: IndicatorRow[] = [
  { id: "rsi", n: "RSI", fam: "Momentum", gated: false },
  { id: "macd", n: "MACD", fam: "Momentum", gated: false },
  { id: "boll", n: "Bollinger", fam: "Volatility", gated: false },
  { id: "adx", n: "ADX", fam: "Strength", gated: false },
  { id: "stoch", n: "Stochastic", fam: "Momentum", gated: false },
  { id: "obv", n: "OBV", fam: "Volume", gated: true },
  { id: "mfi", n: "MFI", fam: "Volume", gated: true },
  { id: "cci", n: "CCI", fam: "Momentum", gated: false },
  { id: "wr", n: "Williams %R", fam: "Momentum", gated: false },
  { id: "atr", n: "ATR", fam: "Volatility", gated: false },
  { id: "roc", n: "ROC", fam: "Momentum", gated: false },
  { id: "psar", n: "PSAR", fam: "Trend", gated: false },
  { id: "ichimoku", n: "Ichimoku", fam: "Trend", gated: false },
  { id: "supertrend", n: "Supertrend", fam: "Trend", gated: false },
  { id: "pivots", n: "Pivot Points", fam: "Trend", gated: false },
  { id: "nr4", n: "NR4 / NR7", fam: "Volatility", gated: false },
];

const FAMILY_COLORS: Record<string, string> = {
  Trend: "#34d399",
  Momentum: "#a78bfa",
  Volatility: "#fbbf24",
  Volume: "#38bdf8",
  Strength: "#f87171",
};

interface ScreenerItem {
  id: number;
  n: string;
  chips: string[];
  mine: boolean;
}
const SCREENERS: ScreenerItem[] = [
  {
    id: 1,
    n: "Cheap quality (mine)",
    chips: ["PE<15", "ROE>15%", "D/E<0.5"],
    mine: true,
  },
  {
    id: 2,
    n: "Compounders",
    chips: ["ROCE>20%", "Debt↓", "Sales 5y CAGR>12"],
    mine: true,
  },
  { id: 3, n: "Magic Formula", chips: ["EY high", "ROCE high"], mine: false },
  {
    id: 4,
    n: "52w breakout",
    chips: ["Price=52w-H", "Vol>1.5×Avg"],
    mine: false,
  },
  { id: 5, n: "Microcap ROE", chips: ["MCap<₹500cr", "ROE>20%"], mine: true },
];

interface StrategyItem {
  id: string;
  n: string;
  t: string;
}
const STRATEGIES = {
  builtin: [
    {
      id: "core-dcf",
      n: "Core DCF",
      t: "10y FCFF DCF with reverse-engineered growth assumptions.",
    },
    {
      id: "quality-mom",
      n: "Quality + Momentum",
      t: "Joel Greenblatt × IBD - earnings stability + price momentum.",
    },
    {
      id: "esg-india",
      n: "ESG India",
      t: "Filters Sustainalytics ESG-risk < 25 and India NSE-500.",
    },
  ] as StrategyItem[],
  books: [
    {
      id: "magic",
      n: "Magic Formula - Greenblatt",
      t: "Earnings yield × ROIC, ranked top decile.",
    },
    {
      id: "garp",
      n: "GARP - Lynch",
      t: "PEG < 1, earnings growth 15-25%, manageable debt.",
    },
    {
      id: "canslim",
      n: "CAN SLIM - O'Neil",
      t: "Quarterly EPS surge + new highs + leader in industry.",
    },
    {
      id: "owner",
      n: "Owner earnings - Buffett",
      t: "FCF + maintenance capex normalisation, 10-year hold.",
    },
  ] as StrategyItem[],
  personas: [
    {
      id: "marks",
      n: "Howard Marks",
      t: "Cycles, second-level thinking, downside-first.",
    },
    {
      id: "damodaran",
      n: "Aswath Damodaran",
      t: "Story → numbers → valuation, narrative discipline.",
    },
    {
      id: "rj",
      n: "Rakesh Jhunjhunwala",
      t: "India compounders, conviction sizing, multi-bagger lens.",
    },
  ] as StrategyItem[],
};

// ─── Local state for not-yet-persisted features ────────────────────────

interface LocalState {
  brokers: Record<string, boolean>;
  webSearch: boolean;
  webSearchUsed: number;
  webSearchCap: number;
  docs: number[];
  pinnedIndicators: string[];
  pinnedScreeners: number[];
  persona: string | null;
  instruments: { stocks: string[]; mfs: string[]; etfs: string[] };
}

const DEFAULT_LOCAL: LocalState = {
  brokers: BROKERS.reduce<Record<string, boolean>>((acc, b) => {
    acc[b.id] = b.id === "zerodha:personal" || b.id === "upstox:trading";
    return acc;
  }, {}),
  webSearch: false,
  webSearchUsed: 0,
  webSearchCap: 200,
  docs: [],
  pinnedIndicators: [],
  pinnedScreeners: [],
  persona: null,
  instruments: { stocks: [], mfs: [], etfs: [] },
};

// ─── Views ──────────────────────────────────────────────────────────────

type View =
  | "root"
  | "style"
  | "skills"
  | "params"
  | "focus"
  | "connectors"
  | "instruments"
  | "web"
  | "docs"
  | "tools";

const VIEW_TITLES: Record<View, string> = {
  root: "Research preferences",
  style: "Research style",
  skills: "Custom skills",
  params: "Run parameters",
  focus: "Always focus on",
  connectors: "Broker accounts",
  instruments: "Stocks · MFs · ETFs",
  web: "Web grounding",
  docs: "Document vault",
  tools: "Tools",
};

interface PromptOptionsPopoverProps {
  size?: "sm" | "md";
}

export default function PromptOptionsPopover({
  size = "md",
}: PromptOptionsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("root");
  const [toolsTab, setToolsTab] = useState<
    "indicators" | "screeners" | "strategies"
  >("indicators");
  const { prefs, isLoading, isSaving, save } = useResearchPreferences();
  const {
    prefs: composer,
    save: saveComposer,
    reload: reloadComposer,
  } = useComposerPreferences();

  // Map persisted composer prefs into the LocalState shape the existing
  // sub-views consume. When the user toggles something the patch flows
  // back through saveComposer so it sticks across sessions.
  const local: LocalState = useMemo(
    () => ({
      brokers: (composer?.connectors.activeBrokerIds ?? []).reduce<
        Record<string, boolean>
      >((acc, id) => {
        acc[id] = true;
        return acc;
      }, {}),
      webSearch: composer?.sources.webSearch ?? false,
      webSearchUsed: composer?.sources.webSearchUsedThisMonth ?? 0,
      webSearchCap: composer?.sources.webSearchCap ?? 200,
      docs:
        composer?.sources.activeDocumentIds.map((id) => Number(id) || 0) ?? [],
      pinnedIndicators: composer?.tools.pinnedIndicators ?? [],
      pinnedScreeners:
        composer?.tools.pinnedScreenerIds.map((id) => Number(id) || 0) ?? [],
      persona: composer?.tools.persona ?? null,
      instruments: composer?.pinnedInstruments ?? {
        stocks: [],
        mfs: [],
        etfs: [],
      },
    }),
    [composer]
  );

  const setLocalPatch = (patch: Partial<LocalState>) => {
    // Translate the LocalState patch back into composer-pref namespaces.
    const composerPatch: Parameters<typeof saveComposer>[0] = {};
    if (patch.brokers) {
      composerPatch.connectors = {
        activeBrokerIds: Object.entries(patch.brokers)
          .filter(([, on]) => on)
          .map(([id]) => id),
      };
    }
    if (patch.webSearch !== undefined) {
      composerPatch.sources = { webSearch: patch.webSearch };
    }
    if (patch.docs) {
      composerPatch.sources = {
        ...(composerPatch.sources ?? {}),
        activeDocumentIds: patch.docs.map(String),
      };
    }
    if (patch.pinnedIndicators) {
      composerPatch.tools = {
        pinnedIndicators: patch.pinnedIndicators as never,
      };
    }
    if (patch.pinnedScreeners) {
      composerPatch.tools = {
        ...(composerPatch.tools ?? {}),
        pinnedScreenerIds: patch.pinnedScreeners.map(String),
      };
    }
    if (patch.persona !== undefined) {
      composerPatch.tools = {
        ...(composerPatch.tools ?? {}),
        persona: patch.persona as never,
      };
    }
    if (patch.instruments) {
      composerPatch.pinnedInstruments = patch.instruments;
    }
    if (Object.keys(composerPatch).length > 0) {
      void saveComposer(composerPatch);
    }
  };

  const [isResetting, setIsResetting] = useState(false);

  /**
   * "Reset all" in the root footer. The button shipped with no onClick, so it
   * rendered as a live control and silently did nothing when clicked.
   *
   * Scope is the COMPOSER preferences this popover's sub-views edit. Research
   * preferences (style / skills / params / focus) are deliberately left alone,
   * so a stray click cannot throw away a configured research setup.
   *
   * The reset itself runs in a server action rather than being assembled
   * here. The canonical defaults live in @usemoney/services, whose
   * preferences module imports prisma, so this client component cannot import
   * them without pulling the DB client into the browser bundle — and keeping
   * the payload server-side also means the web-search usage meter cannot be
   * refilled by a hand-crafted client call. See
   * resetMyComposerPreferencesAction.
   */
  const handleResetAll = async () => {
    if (isResetting) return;
    setIsResetting(true);
    try {
      const res = await resetMyComposerPreferencesAction();
      if (res.success) {
        // The hook holds its own copy of the prefs; re-read so every
        // sub-view reflects the reset without needing a remount.
        await reloadComposer();
      }
    } finally {
      setIsResetting(false);
    }
  };

  // MONEY-394 I - Free users are limited to {auto, quick, deep}.
  // Comprehensive, Advanced, Custom remain visible in the picker but
  // disabled with a 'Pro' chip + upgrade toast on click.
  // MONEY-457: ignore the hook's initial "FREE" default while loading —
  // treating an unloaded plan as Free was triggering false "Pro feature"
  // toasts for Premium users who clicked Advanced before the subscription
  // fetch returned. Server-side credit check is the final authority.
  const { planId, isLoading: planLoading } = useSubscriptionAccess(false);
  const isFreePlan = !planLoading && planId === "FREE";
  // MONEY-394 - Document Vault as a research source is Premium-only.
  // Custom skills stays on the broader FREE-only lock; Document Vault
  // gates higher because it taps the (PREMIUM-tier) doc-vault feature.
  const isBelowPremium = planId !== "PREMIUM" && planId !== "ULTIMATE";
  const PRO_ONLY_STYLES: readonly ResearchStyle[] = [
    "comprehensive",
    "advanced",
    "custom",
  ] as const;
  const isStyleLocked = (s: ResearchStyle) =>
    isFreePlan && PRO_ONLY_STYLES.includes(s);

  const handleStyleChange = (next: ResearchStyle) => {
    if (isStyleLocked(next)) {
      toast.error(
        `${next.charAt(0).toUpperCase()}${next.slice(1)} research is a Pro feature - upgrade to unlock.`,
        { duration: 4000 }
      );
      return;
    }
    // For Comprehensive (L3) and Advanced (L4), auto-apply the matching
    // preset's default skill bundle so the planner runs the right tier.
    // Quick/Deep/Auto/Custom keep the user's existing skill selection.
    if (next === "comprehensive") {
      save({
        researchStyle: next,
        customSkills: [...RESEARCH_PRESET_DEFS.comprehensive.defaultSkills],
      });
    } else if (next === "advanced") {
      save({
        researchStyle: next,
        customSkills: [
          ...RESEARCH_PRESET_DEFS["l4-institutional"].defaultSkills,
        ],
      });
    } else {
      save({ researchStyle: next });
    }
  };
  // MONEY-219 PR-3 patch: normalize-on-write so v1 alias IDs in any
  // future input (e.g., a preset that still references legacy IDs)
  // get persisted as their v2 expansions. Over time the on-disk
  // value converges to v2-only.
  const handleSkillsChange = (next: ResearchSkillId[]) =>
    save({ customSkills: expandSkillAliases(next) });
  const handleFocusCommit = (next: string) => save({ researchFocus: next });
  // MONEY-801 — institutional run-parameters. Persisted to research prefs so a
  // chat-triggered run honours the saved horizon / benchmark / report depth /
  // VaR config / DCF assumptions (the chat route resolves these from prefs and
  // injects them into the run_research confirmation params). Each is optional;
  // an unset value reproduces today's plan + report.
  const handleParamsChange = (
    patch: Pick<
      Partial<ResearchPreferencesInput>,
      "horizon" | "benchmark" | "reportLength" | "varConfig" | "assumptions"
    >
  ) => save(patch);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setView("root");
  };

  const style = prefs?.researchStyle ?? "auto";
  // Normalize-on-read so existing users with saved v1 IDs (`investment-thesis`,
  // `peer-comparison`, etc.) see their selections rendered against the v2
  // chips in the picker. Without this, the count showed "6 selected" but
  // every checkbox was empty because the v1 IDs didn't match any v2 row.id.
  const skills = expandSkillAliases(
    (prefs?.customSkills ?? []) as ResearchSkillId[]
  );
  const focus = prefs?.researchFocus ?? "";
  // MONEY-801 — count of saved run-params that deviate from their default.
  const runParamsActive = countRunParams({
    horizon: prefs?.horizon,
    benchmark: prefs?.benchmark,
    reportLength: prefs?.reportLength,
    varConfig: prefs?.varConfig,
    assumptions: prefs?.assumptions,
  });

  const triggerSize = size === "sm" ? "h-7 w-7" : "h-9 w-9";

  // Override dot fires whenever ANY non-default state is in effect.
  const hasOverride =
    style !== "auto" ||
    skills.length > 0 ||
    focus.trim().length > 0 ||
    runParamsActive > 0 ||
    local.webSearch ||
    local.docs.length > 0 ||
    local.pinnedIndicators.length > 0 ||
    local.pinnedScreeners.length > 0 ||
    local.persona !== null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Research options"
          data-walkthrough="chat-plus-icon"
          className={`${triggerSize} pf-bf relative shrink-0 mb-0.5 grid place-items-center`}
          style={
            open
              ? {
                  padding: 0,
                  background: "var(--emerald)",
                  color: "var(--paper)",
                  borderColor: "var(--ink)",
                }
              : { padding: 0 }
          }
        >
          <Plus className="w-4 h-4" />
          {hasOverride && !open && (
            <span
              aria-hidden
              className="absolute top-[1px] right-[1px] w-2 h-2 rounded-full"
              style={{
                background: "var(--emerald)",
                boxShadow: "0 0 0 2px var(--paper)",
              }}
            />
          )}
          {local.persona && (
            <span
              aria-hidden
              className="absolute -inset-px rounded-[11px] pointer-events-none"
              style={{ boxShadow: "0 0 0 2px var(--pop-5)" }}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        avoidCollisions
        collisionPadding={12}
        className="pf-card pf-app p-0 overflow-hidden flex flex-col"
        style={{
          // Responsive - full-bleed on mobile (with 12px viewport
          // padding from collisionPadding), 360px fixed on sm+. Height
          // caps at min(540, viewport - 80) so the bottom edge doesn't
          // clip on short phone screens.
          width: "min(360px, calc(100vw - 24px))",
          maxWidth: "calc(100vw - 24px)",
          height: "min(540px, calc(100vh - 80px))",
          maxHeight: "calc(100vh - 80px)",
          borderRadius: 16,
          boxShadow: "var(--shadow-hard)",
        }}
      >
        <PopHeader
          title={VIEW_TITLES[view]}
          onBack={view === "root" ? null : () => setView("root")}
          right={
            view === "root" ? (
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="h-6 w-6 grid place-items-center rounded-md pf-bf"
                style={{ padding: 0 }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null
          }
        />

        <div
          className="flex-1 min-h-0 overflow-y-auto"
          style={{ scrollbarColor: "var(--rule-soft) transparent" }}
        >
          {isLoading && !prefs ? (
            // MONEY-877: a structured skeleton instead of bare "Loading…" text while
            // the prefs fetch is in flight — mirrors the root view's grouped rows so
            // the popover height/structure doesn't jump when the data lands.
            <div className="px-4 py-3 space-y-4" aria-busy="true">
              {[0, 1, 2].map((g) => (
                <div key={g} className="space-y-2">
                  <div
                    className="h-2.5 w-24 rounded"
                    style={{ background: "var(--rule-soft)" }}
                  />
                  {[0, 1, 2].map((r) => (
                    <div key={r} className="flex items-center gap-3">
                      <div
                        className="h-7 w-7 rounded"
                        style={{ background: "var(--rule-soft)" }}
                      />
                      <div className="flex-1 space-y-1.5">
                        <div
                          className="h-2.5 w-1/3 rounded"
                          style={{ background: "var(--rule-soft)" }}
                        />
                        <div
                          className="h-2 w-2/3 rounded"
                          style={{ background: "var(--paper-2)" }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : view === "root" ? (
            <RootView
              style={style}
              skills={skills}
              focus={focus}
              runParamsActive={runParamsActive}
              local={local}
              onPick={(v) => setView(v)}
              onPickTool={(tab) => {
                setToolsTab(tab);
                setView("tools");
              }}
              onClearPersona={() => setLocalPatch({ persona: null })}
              isFreePlan={isFreePlan}
              isBelowPremium={isBelowPremium}
              onLockedClick={(label, requiredTier) =>
                toast.error(
                  `${label} is a ${requiredTier === "PREMIUM" ? "Premium" : "Pro"} feature - upgrade to unlock.`,
                  { duration: 4000 }
                )
              }
            />
          ) : view === "style" ? (
            <StyleView
              value={style}
              onChange={handleStyleChange}
              disabled={isSaving}
              lockedStyles={
                isFreePlan ? PRO_ONLY_STYLES : ([] as readonly ResearchStyle[])
              }
            />
          ) : view === "skills" ? (
            <SkillsView
              style={style}
              value={skills}
              onChange={handleSkillsChange}
              disabled={isSaving}
            />
          ) : view === "params" ? (
            <RunParamsView
              horizon={prefs?.horizon}
              benchmark={prefs?.benchmark}
              reportLength={prefs?.reportLength}
              varConfig={prefs?.varConfig}
              assumptions={prefs?.assumptions}
              onChange={handleParamsChange}
              disabled={isSaving}
            />
          ) : view === "focus" ? (
            <FocusView
              value={focus}
              onCommit={handleFocusCommit}
              isSaving={isSaving}
            />
          ) : view === "connectors" ? (
            <ConnectorsView local={local} setLocal={setLocalPatch} />
          ) : view === "instruments" ? (
            <InstrumentsView local={local} setLocal={setLocalPatch} />
          ) : view === "web" ? (
            <WebView local={local} setLocal={setLocalPatch} />
          ) : view === "docs" ? (
            <DocsView local={local} setLocal={setLocalPatch} />
          ) : view === "tools" ? (
            <ToolsView
              tab={toolsTab}
              setTab={setToolsTab}
              local={local}
              setLocal={setLocalPatch}
            />
          ) : null}
        </div>

        {view === "root" && (
          <RootFooter onResetAll={handleResetAll} isResetting={isResetting} />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function summariseStyle(style: ResearchStyle): string {
  return STYLES.find((s) => s.id === style)?.name ?? "Auto";
}

function summariseSkills(skills: readonly ResearchSkillId[]): string {
  if (skills.length === 0) return "None";
  if (skills.length <= 2)
    return skills
      .map((s) => RESEARCH_SKILL_LABELS[s].split(" ")[0])
      .join(" + ");
  return `${skills.length} selected`;
}

function summariseFocus(focus: string): string {
  const trimmed = focus.trim();
  if (!trimmed) return "Not set";
  if (trimmed.length <= 18) return `“${trimmed}”`;
  return `“${trimmed.slice(0, 18)}…”`;
}

function summariseConnectors(local: LocalState): string {
  const active = BROKERS.filter((b) => local.brokers[b.id]);
  if (active.length === 0) return "None";
  if (active.length === 1) return active[0]!.platformLabel;
  return `${active[0]!.platformLabel} +${active.length - 1}`;
}

function summariseInstruments(local: LocalState): string {
  const all = [
    ...local.instruments.stocks,
    ...local.instruments.mfs,
    ...local.instruments.etfs,
  ];
  if (all.length === 0) return "None";
  if (all.length === 1) return all[0]!;
  if (all.length <= 3) return `${all[0]} +${all.length - 1}`;
  return `${all.length} selected`;
}

function summariseWeb(local: LocalState): string {
  return local.webSearch
    ? `${local.webSearchUsed} / ${local.webSearchCap}`
    : "Off";
}

function summariseDocs(local: LocalState): string {
  return local.docs.length === 0 ? "None" : `${local.docs.length} active`;
}

function summariseIndicators(local: LocalState): string {
  return local.pinnedIndicators.length === 0
    ? "All on"
    : `${local.pinnedIndicators.length} pinned`;
}

function summariseScreeners(local: LocalState): string {
  return local.pinnedScreeners.length === 0
    ? "None"
    : `${local.pinnedScreeners.length} pinned`;
}

function summariseStrategies(local: LocalState): string {
  if (!local.persona) return "Default";
  return (
    STRATEGIES.personas.find((p) => p.id === local.persona)?.n.split(" ")[0] ??
    "Default"
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────

function PopHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: (() => void) | null;
  right: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2.5 px-3.5 py-3 shrink-0"
      style={{ borderBottom: "2px solid var(--ink)" }}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="h-[26px] w-[26px] rounded-lg grid place-items-center pf-bf"
          style={{ padding: 0 }}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      ) : (
        <Settings2
          className="h-[15px] w-[15px]"
          style={{ color: "var(--ink-3)" }}
        />
      )}
      <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
        {title}
      </span>
      <div className="ml-auto flex items-center gap-1.5">{right}</div>
    </div>
  );
}

interface RootFooterProps {
  /**
   * Clears every research preference this popover edits, back to defaults.
   * Required, not optional — the button was previously rendered with NO
   * handler at all, so it looked live and did nothing. Making this mandatory
   * means a future caller cannot reintroduce the dead button by omission.
   */
  onResetAll: () => void;
  /** Disables the button while the reset is being persisted. */
  isResetting: boolean;
}

function RootFooter({ onResetAll, isResetting }: RootFooterProps) {
  // Live credit count from chat context - single source of truth across the
  // composer (matches the credit pill at the top-right of the chat input).
  const { subscriptionAccess } = useChatContext();
  // MONEY-1199 — the denominator must span the SAME allowances as the
  // numerator. `totalCreditsRemaining` is plan remaining PLUS pack remaining,
  // while `creditsLimit` is the plan's allowance alone (packs live in
  // `packCreditsLimit`). Pairing them rendered "2750 / 200 credits" for anyone
  // who had bought a query pack — a used count larger than the limit, which is
  // not a number that can exist.
  const remaining = subscriptionAccess?.totalCreditsRemaining ?? 0;
  const limit =
    (subscriptionAccess?.creditsLimit ?? 0) +
    (subscriptionAccess?.packCreditsLimit ?? 0);

  return (
    <div
      className="mono flex items-center gap-2.5 px-3.5 py-2.5 shrink-0"
      style={{
        borderTop: "1.5px dashed var(--rule-soft)",
        background: "var(--paper-2)",
      }}
    >
      <span
        className="inline-flex items-center gap-1.5"
        style={{ fontSize: 10.5, color: "var(--ink-3)" }}
      >
        <span
          className="w-[5px] h-[5px] rounded-full"
          style={{ background: "var(--emerald)" }}
        />
        <span style={{ color: "var(--emerald-text)" }}>{remaining}</span>
        {limit > 0 && <> / {limit}</>} credits
      </span>
      <button
        type="button"
        className="pf-bf ml-auto"
        style={{ fontSize: 10.5, padding: "3px 9px" }}
        onClick={onResetAll}
        disabled={isResetting}
      >
        {isResetting ? "Resetting…" : "Reset all"}
      </button>
    </div>
  );
}

function SectionLabel({
  children,
  style,
}: {
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="mono px-3 pt-2.5 pb-1.5"
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "1.5px",
        color: "var(--ink-3)",
        textTransform: "uppercase",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

interface RootRowProps {
  Icon: LucideIcon;
  label: string;
  summary: string;
  hint?: string;
  accent?: string;
  override?: boolean;
  endAdornment?: ReactNode;
  onClick: () => void;
  /** MONEY-394 J - render a 'Pro' chip + dim the row; click should
   *  surface an upgrade toast instead of opening the sub-view. */
  locked?: boolean;
  /** MONEY-394 - chip text when `locked` is true. Defaults to 'Pro'. */
  lockTierLabel?: string;
}

function RootRow({
  Icon,
  label,
  summary,
  hint,
  accent = "#34d399",
  override = false,
  endAdornment,
  onClick,
  locked = false,
  lockTierLabel = "Pro",
}: RootRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 rounded-[10px] px-2.5 py-2.5 transition-colors text-left"
      style={{
        opacity: locked ? 0.55 : 1,
        cursor: "pointer",
      }}
    >
      <span
        className="relative grid place-items-center w-7 h-7 shrink-0"
        style={{
          borderRadius: 7,
          background: accent ?? "var(--emerald)",
          color: "var(--paper)",
          border: "1.5px solid var(--ink)",
          transform: "rotate(-3deg)",
          boxShadow: "2px 2px 0 var(--ink)",
        }}
      >
        <Icon className="h-3.5 w-3.5" />
        {override && (
          <span
            aria-hidden
            className="absolute -top-[3px] -right-[3px] w-2 h-2 rounded-full"
            style={{
              background: "var(--pop-1)",
              boxShadow: `0 0 0 2px var(--paper)`,
            }}
          />
        )}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
          {label}
        </div>
        {locked && (
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color: "var(--emerald-text)",
              padding: "1px 6px",
              borderRadius: 4,
              border: "1.5px solid var(--emerald)",
              letterSpacing: 0.6,
              textTransform: "uppercase",
              fontWeight: 700,
            }}
            title={`Upgrade to ${lockTierLabel} to unlock`}
          >
            {lockTierLabel}
          </span>
        )}
        {hint && (
          <div
            className="w-full mt-0.5"
            style={{ fontSize: 11, color: "var(--ink-3)" }}
          >
            {hint}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {endAdornment}
        <span
          className="mono truncate max-w-[140px]"
          style={{
            fontSize: 11.5,
            color: "var(--ink-3)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {summary}
        </span>
        <ChevronRight
          className="h-[13px] w-[13px] shrink-0"
          style={{ color: "var(--ink-3)" }}
        />
      </div>
    </button>
  );
}

function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className="relative shrink-0 rounded-full p-0 transition-colors"
      style={{
        width: 36,
        height: 20,
        background: on ? "var(--emerald)" : "var(--rule-soft)",
        border: on ? "1.5px solid var(--ink)" : "1.5px solid var(--rule-soft)",
        cursor: "pointer",
      }}
    >
      <span
        className="absolute rounded-full transition-[left] duration-150"
        style={{
          top: 2,
          left: on ? 18 : 2,
          width: 16,
          height: 16,
          background: "var(--paper)",
          border: "1px solid var(--rule-soft)",
        }}
      />
    </button>
  );
}

function StatusPill({ status }: { status: "active" | "expired" | "never" }) {
  const map = {
    active: { c: "var(--emerald)", ct: "var(--emerald-text)", t: "Active" },
    expired: { c: "var(--pop-3)", ct: "var(--pop-3-text)", t: "Token expired" },
    never: { c: "var(--ink-3)", ct: "var(--ink-3)", t: "Never synced" },
  };
  const s = map[status];
  return (
    <span
      className="mono inline-flex items-center gap-[5px]"
      style={{
        padding: "2px 7px",
        borderRadius: 6,
        border: `1.5px solid ${s.c}`,
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: 0.3,
        color: s.ct,
      }}
    >
      <span
        className="rounded-full"
        style={{ width: 5, height: 5, background: s.c }}
      />
      {s.t}
    </span>
  );
}

// ─── Root view ──────────────────────────────────────────────────────────

interface RootViewProps {
  style: ResearchStyle;
  skills: readonly ResearchSkillId[];
  focus: string;
  /** MONEY-801 - count of saved run-params deviating from default. */
  runParamsActive: number;
  local: LocalState;
  onPick: (v: View) => void;
  onPickTool: (tab: "indicators" | "screeners" | "strategies") => void;
  onClearPersona: () => void;
  /** MONEY-394 J - lock Custom skills (Pro-gated). */
  isFreePlan?: boolean;
  /** MONEY-394 - lock Document vault (Premium-gated). */
  isBelowPremium?: boolean;
  onLockedClick?: (label: string, requiredTier: "PRO" | "PREMIUM") => void;
}

function RootView({
  style,
  skills,
  focus,
  runParamsActive,
  local,
  onPick,
  onPickTool,
  onClearPersona,
  isFreePlan = false,
  isBelowPremium = false,
  onLockedClick,
}: RootViewProps) {
  const persona = local.persona
    ? STRATEGIES.personas.find((p) => p.id === local.persona)
    : null;
  const activeBrokerCount = BROKERS.filter((b) => local.brokers[b.id]).length;
  const styleAccent = STYLES.find((s) => s.id === style)?.accent ?? "#34d399";

  return (
    <div className="p-2">
      {persona && (
        <div className="px-2.5 pt-1 pb-1 flex">
          <PersonaPill name={persona.n} onClear={onClearPersona} />
        </div>
      )}

      <SectionLabel>Research preferences</SectionLabel>
      <RootRow
        Icon={Sparkles}
        label="Research style"
        summary={summariseStyle(style)}
        accent={styleAccent}
        override={style !== "auto"}
        onClick={() => onPick("style")}
      />
      <RootRow
        Icon={Wand2}
        label="Custom skills"
        summary={summariseSkills(skills)}
        accent="#3b82f6"
        override={skills.length > 0}
        locked={isFreePlan}
        onClick={() => {
          if (isFreePlan) {
            onLockedClick?.("Custom skills", "PRO");
            return;
          }
          onPick("skills");
        }}
      />
      <RootRow
        Icon={Pencil}
        label="Always focus on"
        summary={summariseFocus(focus)}
        accent="#fbbf24"
        override={focus.trim().length > 0}
        onClick={() => onPick("focus")}
      />
      <RootRow
        Icon={SlidersHorizontal}
        label="Run parameters"
        summary={runParamsActive > 0 ? `${runParamsActive} set` : "Defaults"}
        accent="#a78bfa"
        override={runParamsActive > 0}
        onClick={() => onPick("params")}
      />

      <Divider />

      <SectionLabel>Sources</SectionLabel>
      <RootRow
        Icon={Plug}
        label="Broker accounts"
        summary={summariseConnectors(local)}
        accent="#34d399"
        endAdornment={
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              color: "var(--emerald-text)",
              padding: "1px 5px",
              borderRadius: 4,
              border: "1.5px solid var(--emerald)",
            }}
          >
            {activeBrokerCount}
          </span>
        }
        onClick={() => onPick("connectors")}
      />
      <RootRow
        Icon={TrendingUp}
        label="Stocks · MFs · ETFs"
        summary={summariseInstruments(local)}
        accent="#34d399"
        override={
          local.instruments.stocks.length +
            local.instruments.mfs.length +
            local.instruments.etfs.length >
          0
        }
        onClick={() => onPick("instruments")}
      />
      <RootRow
        Icon={Globe}
        label="Live web grounding"
        summary={summariseWeb(local)}
        accent="#38bdf8"
        override={local.webSearch}
        onClick={() => onPick("web")}
      />
      <RootRow
        Icon={FolderOpen}
        label="Document vault"
        summary={summariseDocs(local)}
        override={local.docs.length > 0}
        locked={isBelowPremium}
        lockTierLabel="Premium"
        onClick={() => {
          if (isBelowPremium) {
            onLockedClick?.("Document vault", "PREMIUM");
            return;
          }
          onPick("docs");
        }}
      />

      <Divider />

      <SectionLabel>Tools</SectionLabel>
      <RootRow
        Icon={Activity}
        label="Indicators"
        summary={summariseIndicators(local)}
        accent="#a78bfa"
        override={local.pinnedIndicators.length > 0}
        hint={
          local.pinnedIndicators.length === 0
            ? "Default: all 16 active"
            : undefined
        }
        onClick={() => onPickTool("indicators")}
      />
      <RootRow
        Icon={Filter}
        label="Screeners"
        summary={summariseScreeners(local)}
        override={local.pinnedScreeners.length > 0}
        onClick={() => onPickTool("screeners")}
      />
      <RootRow
        Icon={UserCog}
        label="Strategies"
        summary={summariseStrategies(local)}
        accent="#a78bfa"
        override={!!local.persona}
        onClick={() => onPickTool("strategies")}
      />
    </div>
  );
}

function Divider() {
  return (
    <div
      className="h-px mx-3 my-2"
      style={{ background: "var(--rule-softer)" }}
    />
  );
}

function PersonaPill({ name, onClear }: { name: string; onClear: () => void }) {
  return (
    <div
      className="mono inline-flex items-center gap-1.5"
      style={{
        padding: "3px 4px 3px 8px",
        borderRadius: 8,
        border: "1.5px solid var(--pop-5)",
        fontSize: 10.5,
        color: "var(--pop-5-text)",
        letterSpacing: 0.2,
      }}
    >
      <span
        className="rounded-full"
        style={{ width: 5, height: 5, background: "var(--pop-5)" }}
      />
      Persona: {name}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear persona"
        className="grid place-items-center pf-bf"
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          cursor: "pointer",
          marginLeft: 2,
        }}
      >
        <X className="w-[9px] h-[9px]" />
      </button>
    </div>
  );
}

// ─── Style view ─────────────────────────────────────────────────────────

function StyleView({
  value,
  onChange,
  disabled,
  lockedStyles = [] as readonly ResearchStyle[],
}: {
  value: ResearchStyle;
  onChange: (next: ResearchStyle) => void;
  disabled?: boolean;
  /** MONEY-394 I - styles that should render with a 'Pro' chip + dimmed
   *  visuals. Clicking still calls onChange which is responsible for the
   *  upgrade toast (so the lock copy stays consistent across surfaces). */
  lockedStyles?: readonly ResearchStyle[];
}) {
  return (
    <div className="p-2 pt-1.5">
      {STYLES.map((s) => {
        const active = value === s.id;
        const locked = lockedStyles.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(s.id)}
            className="w-full text-left flex items-start gap-3 mb-1 transition-colors disabled:opacity-50"
            style={{
              padding: "12px 12px",
              background: active ? "var(--paper-2)" : "transparent",
              border: active
                ? "1.5px solid var(--ink)"
                : "1.5px solid transparent",
              borderRadius: 10,
              cursor: disabled ? "not-allowed" : "pointer",
              color: "var(--ink)",
              opacity: locked ? 0.55 : 1,
            }}
          >
            <span
              className="grid place-items-center shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: s.accent,
                color: "var(--paper)",
                border: "1.5px solid var(--ink)",
                transform: "rotate(-3deg)",
                boxShadow: "2px 2px 0 var(--ink)",
              }}
            >
              <s.Icon className="h-[15px] w-[15px]" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {s.name}
                </span>
                {locked && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      color: "var(--emerald-text)",
                      padding: "1px 6px",
                      borderRadius: 4,
                      border: "1.5px solid var(--emerald)",
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                      fontWeight: 700,
                    }}
                    title="Upgrade to Pro to unlock"
                  >
                    Pro
                  </span>
                )}
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: "var(--ink-3)",
                    padding: "1px 6px",
                    borderRadius: 4,
                    border: "1.5px solid var(--rule-soft)",
                  }}
                >
                  {s.time} · {s.credits}
                </span>
              </div>
              <div
                className="leading-snug"
                style={{ fontSize: 11.5, color: "var(--ink-3)" }}
              >
                {s.blurb}
              </div>
            </div>
            <span
              className="grid place-items-center shrink-0 mt-2"
              style={{
                width: 16,
                height: 16,
                borderRadius: 999,
                border: `1.5px solid ${active ? s.accent : "var(--rule-soft)"}`,
              }}
            >
              {active && (
                <span
                  className="rounded-full"
                  style={{ width: 7, height: 7, background: s.accent }}
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Skills view ────────────────────────────────────────────────────────

function SkillsView({
  style,
  value,
  onChange,
  disabled,
}: {
  style: ResearchStyle;
  value: readonly ResearchSkillId[];
  onChange: (next: ResearchSkillId[]) => void;
  disabled?: boolean;
}) {
  const meaningful = style === "custom";
  const toggle = (id: ResearchSkillId) =>
    onChange(
      value.includes(id) ? value.filter((x) => x !== id) : [...value, id]
    );

  // MONEY-219 PR-3 - clicking a preset chip overwrites the skill set
  // with that preset's defaults. The user can still toggle individual
  // skills afterward; the preset id itself is persisted by a separate
  // composer write (handler at the popover root, not here).
  const applyPreset = (presetId: ResearchPresetId) => {
    const def = RESEARCH_PRESET_DEFS[presetId];
    onChange([...def.defaultSkills]);
  };

  // Group rows for sectioned rendering. Preserves the SKILL_ROWS order
  // within each group.
  const groupedRows = SKILL_ROWS.reduce<Record<SkillRow["group"], SkillRow[]>>(
    (acc, row) => {
      (acc[row.group] ||= []).push(row);
      return acc;
    },
    {} as Record<SkillRow["group"], SkillRow[]>
  );

  return (
    <>
      {!meaningful && (
        <div
          className="mx-2 mt-1.5 mb-0.5 flex gap-2 items-start"
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "1.5px dashed var(--rule-soft)",
            fontSize: 11.5,
            color: "var(--ink-3)",
          }}
        >
          <HelpCircle
            className="h-[13px] w-[13px] shrink-0 mt-0.5"
            style={{ color: "var(--ink-3)" }}
          />
          <div>
            Skills run only when style is{" "}
            <b style={{ color: "var(--ink)" }}>Custom</b>. Edits saved either
            way.
          </div>
        </div>
      )}

      {/* Preset chips - quick-pick a curated bundle */}
      <div
        className="mx-2 mt-2 mb-1"
        style={{
          padding: "9px 10px",
          borderRadius: 8,
          border: "1.5px dashed var(--rule-soft)",
          background: "var(--paper-2)",
        }}
      >
        <div
          className="flex items-center gap-1.5 mb-2"
          style={{ fontSize: 11, letterSpacing: 1.2 }}
        >
          <Sparkles
            className="h-3 w-3"
            style={{ color: "var(--emerald-text)" }}
          />
          <span
            className="mono uppercase font-bold"
            style={{ color: "var(--emerald-text)" }}
          >
            Presets
          </span>
          <span
            className="mono ml-auto"
            style={{ fontSize: 10, color: "var(--ink-3)" }}
          >
            click to load defaults
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_CHIPS.map((id) => {
            const def = RESEARCH_PRESET_DEFS[id];
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                onClick={() => applyPreset(id)}
                title={`${def.description} · ~${def.baseCredits} credits`}
                className="pf-bf disabled:opacity-50"
                style={{
                  fontSize: 11.5,
                  padding: "4px 9px",
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                {def.shortLabel}
                <span
                  style={{
                    marginLeft: 4,
                    color: "var(--ink-3)",
                    fontSize: 10,
                  }}
                >
                  · {def.baseCredits}c
                </span>
              </button>
            );
          })}
        </div>
        <div
          className="mono mt-2"
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          Selected: <b style={{ color: "var(--ink)" }}>{value.length}</b> / 16
          skills · est.{" "}
          <b style={{ color: "var(--ink)" }}>
            ~{Math.max(1, Math.ceil(value.length * 0.25 + 1))}
          </b>{" "}
          credits
        </div>
      </div>

      <div className="px-1.5 pt-1 pb-1.5">
        {(["fundamentals", "quant", "macro", "risk-news"] as const).map(
          (group) => (
            <div key={group}>
              <div
                className="mono uppercase font-bold mt-1.5 mb-0.5"
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
                    disabled={disabled}
                    onClick={() => toggle(row.id)}
                    title={RESEARCH_SKILL_DESCRIPTIONS[row.id]}
                    className="w-full flex items-center gap-2.5 mb-0.5 disabled:opacity-50"
                    style={{
                      padding: "9px 10px",
                      borderRadius: 8,
                      cursor: disabled ? "not-allowed" : "pointer",
                      background: on ? "var(--paper-2)" : "transparent",
                      border: on
                        ? "1.5px solid var(--rule-soft)"
                        : "1.5px solid transparent",
                      color: "var(--ink)",
                      textAlign: "left",
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
                        color: "var(--paper)",
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
                    <span style={{ fontSize: 13 }} className="flex-1">
                      {RESEARCH_SKILL_LABELS[row.id]}
                    </span>
                  </button>
                );
              })}
            </div>
          )
        )}
      </div>
    </>
  );
}

// ─── Focus view ─────────────────────────────────────────────────────────

function FocusView({
  value,
  onCommit,
  isSaving,
}: {
  value: string;
  onCommit: (next: string) => void;
  isSaving?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChange = (next: string) => {
    const clipped = next.slice(0, FOCUS_MAX);
    setDraft(clipped);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onCommit(clipped.trim()), 500);
  };

  const handleBlur = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };

  const addQuick = (token: string) => {
    const next = draft ? `${draft}, ${token}` : token;
    handleChange(next);
  };

  return (
    <div className="px-2.5 py-2">
      <p
        className="mx-0.5 mt-0.5 mb-2 leading-snug"
        style={{ fontSize: 11.5, color: "var(--ink-3)" }}
      >
        Pinned to every research request. Plain English - no syntax.
      </p>
      <textarea
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder="e.g. margin expansion, India-listed only, AI exposure"
        className="w-full"
        style={{
          minHeight: 110,
          background: "var(--paper)",
          border: "1.5px solid var(--ink)",
          borderRadius: 10,
          padding: "10px 12px",
          color: "var(--ink)",
          fontFamily: "inherit",
          fontSize: 13,
          outline: "none",
          resize: "vertical",
          lineHeight: 1.5,
        }}
      />
      <div className="flex justify-between mt-1.5 px-0.5">
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          {draft.length} / {FOCUS_MAX}
          {isSaving && <span className="ml-2">· saving…</span>}
        </span>
        <button
          type="button"
          onClick={() => handleChange("")}
          disabled={!draft}
          className="pf-bf disabled:opacity-40"
          style={{ fontSize: 11, padding: "2px 8px" }}
        >
          Clear
        </button>
      </div>
      <div className="mt-3.5">
        <div
          className="mono mb-1.5"
          style={{
            fontSize: 9.5,
            letterSpacing: "1.5px",
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          Quick add
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FOCUS_QUICK_ADDS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => addQuick(t)}
              className="pf-bf"
              style={{
                fontSize: 11,
                padding: "4px 9px",
                cursor: "pointer",
              }}
            >
              + {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Run parameters view (MONEY-801) ─────────────────────────────────────

/**
 * Count the saved run-params that deviate from their behaviour-neutral
 * default. Mirrors the omit-when-default forwarding so the root-row badge and
 * the worker-facing extras agree.
 *
 * NOTE on "clearing": `setResearchPreferences` merges with `?? existing`, so a
 * partial patch can never null a saved field by sending `undefined`. The chat
 * picker therefore persists the historical defaults as concrete values rather
 * than unset — `horizon "1y"` (the hardcoded price-history default per the
 * schema) and `benchmark "NIFTY50"` (→ `^NSEI`). Both are byte-identical to
 * unset at the worker, AND can be re-selected to "clear" the override. This
 * counter treats them as inactive so the badge reflects real deviations:
 *   - horizon: only 3y / 5y count (1y == default).
 *   - benchmark: only SENSEX / NIFTY500 / sector count (NIFTY50 == ^NSEI).
 *   - reportLength: only brief / full count ("standard" == default).
 *   - varConfig: any non-95% / non-1-day field counts.
 *   - assumptions: each finite override field counts.
 */
function countRunParams(p: {
  horizon?: ResearchHorizon;
  benchmark?: string;
  reportLength?: ResearchReportLength;
  varConfig?: ResearchVarConfig;
  assumptions?: ResearchAssumptions;
}): number {
  let n = 0;
  if (p.horizon && p.horizon !== "1y") n += 1;
  if (p.benchmark && p.benchmark.trim() && p.benchmark !== "NIFTY50") n += 1;
  if (p.reportLength && p.reportLength !== "standard") n += 1;
  if (p.varConfig?.confidence === 99 || p.varConfig?.horizonDays === 10) n += 1;
  if (p.assumptions) {
    if (Number.isFinite(p.assumptions.wacc)) n += 1;
    if (Number.isFinite(p.assumptions.terminalGrowth)) n += 1;
    if (Number.isFinite(p.assumptions.growthOverride)) n += 1;
  }
  return n;
}

function ParamSegmented({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center"
      style={{
        borderRadius: 8,
        border: "1.5px solid var(--rule-soft)",
        overflow: "hidden",
        background: "var(--paper)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              padding: "5px 10px",
              cursor: disabled ? "not-allowed" : "pointer",
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

function ParamPct({
  label,
  value,
  onCommit,
  placeholder,
  disabled,
}: {
  label: string;
  value: number | undefined;
  onCommit: (next: number | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  // Local text draft so an empty field stays "unset" (vs 0). Stored as a
  // fraction (0.11) but edited as a percentage (11).
  const [draft, setDraft] = useState(
    value === undefined ? "" : String(Math.round(value * 1000) / 10)
  );
  useEffect(() => {
    setDraft(value === undefined ? "" : String(Math.round(value * 1000) / 10));
  }, [value]);

  const commit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return onCommit(undefined);
    const pct = Number(trimmed);
    if (!Number.isFinite(pct)) return onCommit(undefined);
    onCommit(pct / 100);
  };

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
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          placeholder={placeholder}
          className="mono w-full"
          style={{
            fontSize: 12,
            padding: "6px 18px 6px 8px",
            background: "var(--paper)",
            border: "1.5px solid var(--rule-soft)",
            borderRadius: 8,
            color: "var(--ink)",
            outline: "none",
          }}
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

function ParamBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="px-1 py-2">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: "var(--ink)",
            textTransform: "uppercase",
            letterSpacing: "1.2px",
          }}
        >
          {label}
        </span>
        {hint && (
          <span style={{ fontSize: 10, color: "var(--ink-3)" }}>{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function RunParamsView({
  horizon,
  benchmark,
  reportLength,
  varConfig,
  assumptions,
  onChange,
  disabled,
}: {
  horizon?: ResearchHorizon;
  benchmark?: string;
  reportLength?: ResearchReportLength;
  varConfig?: ResearchVarConfig;
  assumptions?: ResearchAssumptions;
  onChange: (
    patch: Pick<
      Partial<ResearchPreferencesInput>,
      "horizon" | "benchmark" | "reportLength" | "varConfig" | "assumptions"
    >
  ) => void;
  disabled?: boolean;
}) {
  // The schema also accepts a free-text sector name, but the chat picker has
  // no text field, so it exposes the three enum-backed indices. A saved
  // free-text value (from another surface) falls back to the NIFTY50 default.
  // The persisted "default" is the concrete "NIFTY50" (→ ^NSEI), so re-picking
  // it can clear an override despite the prefs-merge never honouring undefined.
  const benchmarkSelection =
    benchmark &&
    (RESEARCH_BENCHMARKS as readonly string[]).includes(benchmark) &&
    benchmark !== "NIFTY50"
      ? benchmark
      : "NIFTY50";
  // Likewise horizon: "1y" IS the hardcoded price-history default, so it is the
  // persisted "Default" selection (clearable + behaviour-neutral).
  const horizonSelection = horizon ?? "1y";
  const confidence = varConfig?.confidence ?? 95;
  const horizonDays = varConfig?.horizonDays ?? 1;

  return (
    <div className="p-2.5">
      <p
        className="mx-0.5 mt-0.5 mb-1 leading-snug"
        style={{ fontSize: 11.5, color: "var(--ink-3)" }}
      >
        Tune how a run is parameterised. Defaults reproduce today&apos;s report
        — change only what you need.
      </p>

      <ParamBlock label="Horizon" hint="Price-history window">
        <ParamSegmented
          disabled={disabled}
          // "1y" is the hardcoded default → labelled "Default" but persisted as
          // the concrete value so re-selecting it clears an override.
          options={RESEARCH_HORIZONS.map((h) => ({
            value: h,
            label: h === "1y" ? "Default" : h.toUpperCase(),
          }))}
          value={horizonSelection}
          onChange={(v) => onChange({ horizon: v as ResearchHorizon })}
        />
      </ParamBlock>

      <ParamBlock label="Benchmark" hint="Beta / relative framing">
        <ParamSegmented
          disabled={disabled}
          options={RESEARCH_BENCHMARKS.map((b) => ({
            value: b,
            label: b === "NIFTY50" ? "NIFTY 50" : b,
          }))}
          value={benchmarkSelection}
          onChange={(v) => onChange({ benchmark: v })}
        />
      </ParamBlock>

      <ParamBlock label="Report length" hint="Synthesis depth">
        <ParamSegmented
          disabled={disabled}
          options={RESEARCH_REPORT_LENGTHS.map((r) => ({
            value: r,
            label: r.charAt(0).toUpperCase() + r.slice(1),
          }))}
          value={reportLength ?? "standard"}
          // "standard" is the default depth; persisted concretely so re-picking
          // it clears a brief/full override (the prefs-merge ignores undefined).
          onChange={(v) =>
            onChange({ reportLength: v as ResearchReportLength })
          }
        />
      </ParamBlock>

      <ParamBlock label="VaR" hint="Confidence · holding days">
        <div className="flex items-center gap-2 flex-wrap">
          <ParamSegmented
            disabled={disabled}
            options={[
              { value: "95", label: "95%" },
              { value: "99", label: "99%" },
            ]}
            value={String(confidence)}
            onChange={(v) => {
              const nextConf = Number(v) === 99 ? 99 : 95;
              onChange({
                varConfig: { confidence: nextConf, horizonDays },
              });
            }}
          />
          <ParamSegmented
            disabled={disabled}
            options={[
              { value: "1", label: "1d" },
              { value: "10", label: "10d" },
            ]}
            value={String(horizonDays)}
            onChange={(v) => {
              const nextDays = Number(v) === 10 ? 10 : 1;
              onChange({
                varConfig: { confidence, horizonDays: nextDays },
              });
            }}
          />
        </div>
      </ParamBlock>

      <ParamBlock label="Assumptions" hint="% · optional">
        <div className="grid grid-cols-3 gap-2">
          <ParamPct
            label="WACC"
            value={assumptions?.wacc}
            placeholder="11"
            disabled={disabled}
            onCommit={(n) =>
              onChange({
                assumptions: { ...(assumptions ?? {}), wacc: n },
              })
            }
          />
          <ParamPct
            label="Term. growth"
            value={assumptions?.terminalGrowth}
            placeholder="4"
            disabled={disabled}
            onCommit={(n) =>
              onChange({
                assumptions: { ...(assumptions ?? {}), terminalGrowth: n },
              })
            }
          />
          <ParamPct
            label="Growth"
            value={assumptions?.growthOverride}
            placeholder="12"
            disabled={disabled}
            onCommit={(n) =>
              onChange({
                assumptions: { ...(assumptions ?? {}), growthOverride: n },
              })
            }
          />
        </div>
      </ParamBlock>
    </div>
  );
}

// ─── Connectors view ────────────────────────────────────────────────────

// MONEY-219 Step 2 - broker brand palette. Keys map to BrokerType
// (uppercase) so the real BrokerConnection rows can lookup their own brand.
// `logo` points at /public/brokers/*.png - see apps/web/lib/brokers/config.ts
// for the source of truth.
const BROKER_BRAND: Record<
  string,
  { label: string; brand: string; logo: string | null }
> = {
  ZERODHA: {
    label: "Zerodha",
    brand: "#387ed1",
    logo: "/brokers/zerodha.png",
  },
  UPSTOX: { label: "Upstox", brand: "#7b2ff7", logo: "/brokers/upstox.png" },
  GROWW: { label: "Groww", brand: "#5eb66e", logo: "/brokers/groww.png" },
  ANGEL_ONE: {
    label: "Angel One",
    brand: "#e85454",
    logo: "/brokers/angel.png",
  },
  ANGEL: { label: "Angel One", brand: "#e85454", logo: "/brokers/angel.png" },
  DHAN: { label: "Dhan", brand: "#f59e42", logo: "/brokers/dhan.png" },
  FYERS: { label: "Fyers", brand: "#2196f3", logo: "/brokers/fyers.png" },
  IBKR: {
    label: "Interactive Brokers",
    brand: "#d61f2a",
    logo: "/brokers/ibkr.png",
  },
  INTERACTIVE_BROKERS: {
    label: "Interactive Brokers",
    brand: "#d61f2a",
    logo: "/brokers/ibkr.png",
  },
};

// "+ Add" button on each platform header. Calls getOAuthUrlAction for the
// broker and redirects straight to the OAuth provider - bypasses /brokers
// so the user doesn't lose context of the chat composer they were in.
// For brokers that require an API-key dialog (Groww), getOAuthUrlAction
// returns success=false; in that case we fall back to /brokers?connect=…
// so the user lands on the dialog flow.
function AddAccountButton({ brokerType }: { brokerType: string }) {
  const [busy, setBusy] = useState(false);
  const handleClick = async () => {
    setBusy(true);
    try {
      const res = await getOAuthUrlAction(
        brokerType as Parameters<typeof getOAuthUrlAction>[0]
      );
      if (res.success && res.url) {
        window.location.href = res.url;
      } else {
        // API-key brokers / demo / errors → land on the brokers page so the
        // user can complete the flow (dialog or sign-up CTA).
        window.location.href = `/brokers?connect=${brokerType.toLowerCase()}`;
      }
    } catch {
      window.location.href = `/brokers?connect=${brokerType.toLowerCase()}`;
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      title="Add another account"
      onClick={handleClick}
      disabled={busy}
      className="pf-bf"
      style={{
        height: 22,
        padding: "0 7px",
        borderRadius: 6,
        cursor: busy ? "wait" : "pointer",
        fontSize: 10,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Plus className="w-2.5 h-2.5" /> {busy ? "…" : "Add"}
    </button>
  );
}

// 3-dot menu on each broker row. Items shown depend on the row's status:
//   - active   → Resync now · Delete account
//   - expired  → Reconnect · Delete account
//   - never    → Connect · Delete account
// Reconnect / Connect both navigate to /brokers (full OAuth flow lives there).
// Resync calls syncBrokerDataAction; Delete calls disconnectBrokerAction.
function BrokerRowMenu({
  row,
  onSynced,
  onDeleted,
}: {
  row: {
    id: string;
    nickname: string;
    platform: string;
    brokerType: string;
    status: "active" | "expired" | "never";
  };
  onSynced: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"sync" | "delete" | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { confirm, confirmDialog } = usePfConfirm();
  // The connectors card uses overflow-hidden so the rounded-corner gradient
  // on its header doesn't bleed; that same clip would hide a normal absolute
  // dropdown. Portal the menu and pin it to the trigger's bounding rect.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null
  );

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menuWidth = 168;
    setMenuPos({
      top: r.bottom + 4,
      left: Math.max(8, r.right - menuWidth),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const handleResync = async () => {
    setBusy("sync");
    try {
      // BrokerType is just a string union/enum at runtime - the registry keys
      // it by uppercase name. Cast at the call boundary.
      await syncBrokerDataAction(
        row.brokerType as Parameters<typeof syncBrokerDataAction>[0],
        ["holdings", "positions", "trades"],
        row.id
      );
      await onSynced();
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Disconnect "${row.nickname}"?`,
      description: "You'll need to re-link the account to sync it again.",
      confirmLabel: "Disconnect",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await disconnectBrokerAction(
        row.brokerType as Parameters<typeof disconnectBrokerAction>[0],
        row.id
      );
      await onDeleted();
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  return (
    <>
      {confirmDialog}
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
        className="grid place-items-center"
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          marginLeft: 2,
          background: open ? "var(--paper-2)" : "transparent",
          border: open
            ? "1.5px solid var(--rule-soft)"
            : "1.5px solid transparent",
          color: "var(--ink-3)",
          cursor: "pointer",
        }}
      >
        <MoreVertical className="w-3 h-3" />
      </button>
      {open &&
        menuPos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="overflow-hidden"
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              zIndex: 1000,
              minWidth: 168,
              borderRadius: 9,
              background: "var(--paper)",
              border: "2px solid var(--ink)",
              boxShadow: "var(--shadow-hard)",
              padding: 4,
            }}
          >
            {row.status === "active" && (
              <button
                type="button"
                onClick={handleResync}
                disabled={busy !== null}
                className="w-full flex items-center gap-2 font-medium"
                style={{
                  padding: "7px 9px",
                  borderRadius: 6,
                  background: "transparent",
                  border: 0,
                  color: "var(--ink)",
                  fontSize: 11.5,
                  cursor: busy ? "wait" : "pointer",
                  textAlign: "left",
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <RefreshCw
                  className={`w-3 h-3 ${busy === "sync" ? "animate-spin" : ""}`}
                  style={{ color: "var(--emerald-text)" }}
                />
                {busy === "sync" ? "Syncing…" : "Resync now"}
              </button>
            )}
            {(row.status === "expired" || row.status === "never") && (
              <a
                href={`/brokers?reconnect=${row.id}`}
                className="w-full flex items-center gap-2 font-medium"
                style={{
                  padding: "7px 9px",
                  borderRadius: 6,
                  background: "transparent",
                  border: 0,
                  color: "var(--ink)",
                  fontSize: 11.5,
                  textDecoration: "none",
                }}
                onClick={() => setOpen(false)}
              >
                <Link2
                  className="w-3 h-3"
                  style={{ color: "var(--pop-3-text)" }}
                />
                {row.status === "expired" ? "Reconnect" : "Connect"}
              </a>
            )}
            <div
              className="my-0.5 mx-1 h-px"
              style={{ background: "var(--rule-softer)" }}
            />
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy !== null}
              className="w-full flex items-center gap-2 font-medium"
              style={{
                padding: "7px 9px",
                borderRadius: 6,
                background: "transparent",
                border: 0,
                color: "var(--pop-1-text)",
                fontSize: 11.5,
                cursor: busy ? "wait" : "pointer",
                textAlign: "left",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Trash2 className="w-3 h-3" />
              {busy === "delete" ? "Removing…" : "Delete account"}
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

function ConnectorsView({
  local,
  setLocal,
}: {
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  type BrokerRow = {
    id: string;
    platform: string;
    brokerType: string; // BrokerType enum value, needed for sync/disconnect
    platformLabel: string;
    nickname: string;
    status: "active" | "expired" | "never";
    meta: string;
    brand: string;
    logo: string | null;
  };

  // Real broker connections from the user's account. Empty array shows
  // the empty-state CTA below.
  const [rows, setRows] = useState<BrokerRow[] | null>(null);

  const refreshRows = useCallback(async () => {
    const res = await getBrokerConnectionsAction();
    if (!res.success || !res.data) {
      setRows([]);
      return;
    }
    setRows(
      res.data.map((b) => {
        const meta = BROKER_BRAND[b.broker.toString().toUpperCase()] ?? {
          label: b.broker,
          brand: "#94a3b8",
          logo: null,
        };
        const status: BrokerRow["status"] =
          b.needsReauth || b.isExpired
            ? "expired"
            : !b.lastSync
              ? "never"
              : "active";
        return {
          id: b.id,
          platform: b.broker.toString().toLowerCase(),
          brokerType: b.broker.toString(),
          platformLabel: meta.label,
          nickname:
            b.accountName?.trim() || b.brokerUserId?.trim() || "Account",
          status,
          meta: b.lastSync
            ? `Last sync ${new Date(b.lastSync).toLocaleDateString()}`
            : status === "never"
              ? "Never synced"
              : "-",
          brand: meta.brand,
          logo: meta.logo,
        };
      })
    );
  }, []);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  const platforms = useMemo(() => {
    const groups: Record<
      string,
      {
        platform: string;
        brokerType: string;
        platformLabel: string;
        brand: string;
        logo: string | null;
        items: BrokerRow[];
      }
    > = {};
    (rows ?? []).forEach((b) => {
      if (!groups[b.platform]) {
        groups[b.platform] = {
          platform: b.platform,
          brokerType: b.brokerType,
          platformLabel: b.platformLabel,
          brand: b.brand,
          logo: b.logo,
          items: [],
        };
      }
      groups[b.platform]!.items.push(b);
    });
    return Object.values(groups);
  }, [rows]);

  const totalActive = (rows ?? []).filter((b) => local.brokers[b.id]).length;
  const setActive = (id: string, on: boolean) =>
    setLocal({ brokers: { ...local.brokers, [id]: on } });

  if (rows === null) {
    return (
      <div
        className="py-12 text-center"
        style={{ fontSize: 12, color: "var(--ink-3)" }}
      >
        Loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 flex flex-col items-center text-center">
        <span
          className="grid place-items-center w-11 h-11 mb-3"
          style={{
            borderRadius: 11,
            background: "var(--emerald)",
            color: "var(--paper)",
            border: "2px solid var(--ink)",
            transform: "rotate(-3deg)",
            boxShadow: "3px 3px 0 var(--ink)",
          }}
        >
          <Plug className="h-5 w-5" />
        </span>
        <div
          className="mb-1"
          style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}
        >
          No brokers connected
        </div>
        <div
          className="leading-snug max-w-[260px] mb-4"
          style={{ fontSize: 11.5, color: "var(--ink-3)" }}
        >
          Connect a broker so StockSage can read your holdings + trades.
        </div>
        <a
          href="/brokers"
          className="pf-bs"
          style={{
            fontSize: 12,
            padding: "7px 14px",
            borderRadius: 9,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Plus className="h-3 w-3" /> Connect a broker
        </a>
      </div>
    );
  }

  return (
    <div className="px-2 pb-2 pt-1.5">
      <div className="flex items-center justify-between px-1.5 pt-1 pb-2">
        <SectionLabel style={{ padding: 0 }}>Linked accounts</SectionLabel>
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
          <span style={{ color: "var(--emerald-text)" }}>{totalActive}</span> /{" "}
          {rows.length} active
        </span>
      </div>

      {platforms.map((p) => (
        <div
          key={p.platform}
          className="mb-2 overflow-hidden"
          style={{
            borderRadius: 12,
            border: "1.5px solid var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          <div
            className="flex items-center gap-2.5 px-3 py-2.5"
            style={{
              borderBottom: "1.5px dashed var(--rule-soft)",
            }}
          >
            <span
              className="grid place-items-center shrink-0 overflow-hidden"
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: p.logo ? "#fff" : p.brand,
                color: "#fff",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              {p.logo ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={p.logo}
                  alt={p.platformLabel}
                  width={26}
                  height={26}
                  style={{ width: 26, height: 26, objectFit: "contain" }}
                />
              ) : (
                p.platformLabel.charAt(0)
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div
                style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}
              >
                {p.platformLabel}
              </div>
              <div
                className="mono mt-px"
                style={{ fontSize: 9.5, color: "var(--ink-3)" }}
              >
                {p.items.length} account{p.items.length > 1 ? "s" : ""}
              </div>
            </div>
            <AddAccountButton brokerType={p.brokerType} />
          </div>
          <div className="p-1">
            {p.items.map((b) => {
              const active = local.brokers[b.id] ?? false;
              return (
                <div
                  key={b.id}
                  className="flex items-center gap-2.5 mb-0.5 last:mb-0"
                  style={{
                    padding: "8px 8px 8px 10px",
                    borderRadius: 8,
                    background: active ? "var(--paper-2)" : "transparent",
                    border: active
                      ? "1.5px solid var(--rule-soft)"
                      : "1.5px solid transparent",
                  }}
                >
                  <span
                    className="grid place-items-center shrink-0 font-mono font-bold"
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: `${b.brand}22`,
                      border: `1px solid ${b.brand}55`,
                      color: b.brand,
                      fontSize: 9,
                    }}
                  >
                    {b.nickname.charAt(0)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: "var(--ink)",
                      }}
                    >
                      {b.nickname}
                    </div>
                    <div
                      className="mono mt-0.5"
                      style={{ fontSize: 10, color: "var(--ink-3)" }}
                    >
                      {b.meta}
                    </div>
                  </div>
                  {b.status === "expired" ? (
                    <span
                      className="mono"
                      style={{
                        padding: "2px 6px",
                        borderRadius: 5,
                        border: "1.5px solid var(--pop-3)",
                        color: "var(--pop-3-text)",
                        fontSize: 9.5,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Expired
                    </span>
                  ) : b.status === "never" ? (
                    <span
                      className="mono"
                      style={{
                        padding: "2px 6px",
                        borderRadius: 5,
                        border: "1.5px solid var(--rule-soft)",
                        color: "var(--ink-3)",
                        fontSize: 9.5,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Never synced
                    </span>
                  ) : (
                    <Toggle on={active} onChange={(v) => setActive(b.id, v)} />
                  )}
                  <BrokerRowMenu
                    row={b}
                    onSynced={refreshRows}
                    onDeleted={refreshRows}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <a
        href="/brokers"
        className="w-full inline-flex items-center justify-center gap-2 mt-1 pf-bf"
        style={{
          padding: 11,
          borderRadius: 10,
          borderStyle: "dashed",
          fontSize: 12,
          textDecoration: "none",
        }}
      >
        <Plus className="w-3.5 h-3.5" /> Link a new broker
      </a>

      <SectionLabel style={{ padding: "16px 6px 6px" }}>
        <span className="inline-flex items-center gap-1.5">
          Data APIs
          <span
            className="mono uppercase"
            style={{
              fontSize: 8.5,
              color: "var(--ink-3)",
              letterSpacing: 1,
              padding: "1px 5px",
              border: "1.5px solid var(--rule-soft)",
              borderRadius: 4,
            }}
          >
            Bring your own
          </span>
        </span>
      </SectionLabel>
      {[
        { n: "Tickertape", desc: "Screener + scorecards" },
        { n: "AlphaVantage", desc: "Global pricing + FX" },
      ].map((api) => (
        <div
          key={api.n}
          className="flex items-center gap-2.5 mb-1"
          style={{
            padding: "10px 10px",
            borderRadius: 10,
            background: "var(--paper-2)",
            border: "1.5px dashed var(--rule-soft)",
          }}
        >
          <span
            className="grid place-items-center shrink-0"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "var(--ink)",
              color: "var(--paper)",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              boxShadow: "2px 2px 0 var(--ink)",
            }}
          >
            <Code className="w-3.5 h-3.5" />
          </span>
          <div className="flex-1">
            <div
              style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}
            >
              {api.n}
            </div>
            <div
              className="mt-px"
              style={{ fontSize: 10.5, color: "var(--ink-3)" }}
            >
              {api.desc}
            </div>
          </div>
          <button
            type="button"
            className="pf-bf"
            style={{
              fontSize: 10.5,
              padding: "4px 9px",
              cursor: "pointer",
            }}
          >
            + API key
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Instruments view ───────────────────────────────────────────────────

function InstrumentsView({
  local,
  setLocal,
}: {
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  const [tab, setTab] = useState<"stocks" | "mfs" | "etfs">("stocks");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<{
    stocks: RichSearchStockResult[];
    mfs: RichSearchMfResult[];
    etfs: RichSearchStockResult[];
  }>({ stocks: [], mfs: [], etfs: [] });

  // Debounce typed query 250ms before firing the rich-search action.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Belt-and-suspenders: every time the active tab changes, drop
  // results for the OTHER tabs. The click handler does this too, but
  // any other code path that mutates `tab` (keyboard nav, deep link,
  // etc.) would otherwise leave stale stock rows visible behind the MF
  // results until the new fetch lands.
  useEffect(() => {
    setResults((prev) => ({
      stocks: tab === "stocks" ? prev.stocks : [],
      mfs: tab === "mfs" ? prev.mfs : [],
      etfs: tab === "etfs" ? prev.etfs : [],
    }));
  }, [tab]);

  // Fire the rich-search whenever the active tab or debounced query
  // changes. Empty-query lands the most-popular N rows for the active
  // kind so the picker isn't blank on first open.
  //
  // Request-ID guard - the cleanup-flag pattern alone wasn't enough: when
  // the popular-empty fetch was slow on QA (EC2 Mongo) and the user typed
  // a query before it returned, a late popular response would overwrite
  // the search response. Bumping a counter on every request and ignoring
  // any response whose ID doesn't match `latest` is bulletproof.
  const reqIdRef = useRef(0);
  useEffect(() => {
    const myReqId = ++reqIdRef.current;
    const fetchTab = tab; // pin so we don't update the wrong slot
    let cancelled = false;
    setIsLoading(true);
    void richSearchInstrumentsAction({
      query: debouncedQ,
      kind: fetchTab,
      limit: 12,
    }).then((res) => {
      if (cancelled || myReqId !== reqIdRef.current) return;
      setIsLoading(false);
      if (res.success && res.data) {
        // Pin to fetchTab (the tab in scope when the request was issued).
        // Using the live `tab` here would let a fast response from a
        // previous tab write into the wrong slot if the user already
        // switched.
        setResults((prev) => ({
          ...prev,
          ...(fetchTab === "stocks" ? { stocks: res.data!.stocks } : {}),
          ...(fetchTab === "mfs" ? { mfs: res.data!.mfs } : {}),
          ...(fetchTab === "etfs" ? { etfs: res.data!.etfs } : {}),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, tab]);

  const sel = local.instruments;
  const totalSel = sel.stocks.length + sel.mfs.length + sel.etfs.length;

  // Map rich-search results into the InstrumentItem shape the row
  // renderer below expects. Defensive on nullable price/AUM.
  //
  // Guard: only ever read from results[tab]. Each item is also tagged with
  // the tab it came from so a future caching/stale-state bug can't render
  // a stock-shaped row inside the MFs/ETFs lane.
  const items: InstrumentItem[] = useMemo(() => {
    if (tab === "stocks") {
      return results.stocks.map((s) => ({
        sym: s.symbol,
        name: s.name,
        px: s.price > 0 ? s.price.toLocaleString("en-IN") : "-",
        chg:
          s.changePercent === 0
            ? "-"
            : `${s.changePercent > 0 ? "+" : ""}${s.changePercent.toFixed(2)}%`,
        pos: s.changePercent >= 0,
        pinned: local.instruments.stocks.includes(s.symbol),
        recent: false,
        exchange: s.exchange,
        sector: s.sector ?? "-",
        mcap:
          s.marketCap !== null ? `${(s.marketCap / 1e12).toFixed(2)}L cr` : "-",
      }));
    }
    if (tab === "etfs") {
      return results.etfs.map((e) => ({
        sym: e.symbol,
        name: e.name,
        px: e.price > 0 ? e.price.toLocaleString("en-IN") : "-",
        chg:
          e.changePercent === 0
            ? "-"
            : `${e.changePercent > 0 ? "+" : ""}${e.changePercent.toFixed(2)}%`,
        pos: e.changePercent >= 0,
        pinned: local.instruments.etfs.includes(e.symbol),
        recent: false,
        exchange: e.exchange,
        bench: e.benchmark ?? "-",
        aum:
          e.marketCap !== null
            ? `${Math.round(e.marketCap / 1e7).toLocaleString("en-IN")} cr`
            : "-",
        liquidity: e.liquidity ?? "Medium",
      }));
    }
    return results.mfs.map((m) => ({
      sym: m.schemeCode,
      name: m.schemeName,
      px: m.nav.toFixed(2),
      nav: m.nav.toFixed(2),
      chg:
        m.changePercent === 0
          ? "-"
          : `${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(2)}%`,
      pos: m.changePercent >= 0,
      pinned: local.instruments.mfs.includes(m.schemeCode),
      recent: false,
      kind: m.category ?? "MF",
      aum:
        m.aum !== null
          ? `${Math.round(m.aum).toLocaleString("en-IN")} cr`
          : "-",
      rating: m.rating ?? 3,
    }));
  }, [tab, results, local.instruments]);

  const suggested = !q ? items.filter((it) => it.pinned).slice(0, 4) : [];
  const rest = q ? items : items.filter((it) => !suggested.includes(it));

  const isSel = (it: InstrumentItem) => sel[tab].includes(it.sym);
  const toggle = (it: InstrumentItem) => {
    const cur = sel[tab];
    const next = cur.includes(it.sym)
      ? cur.filter((s) => s !== it.sym)
      : [...cur, it.sym];
    setLocal({ instruments: { ...sel, [tab]: next } });
  };
  const removeChip = (kind: "stocks" | "mfs" | "etfs", sym: string) =>
    setLocal({
      instruments: { ...sel, [kind]: sel[kind].filter((s) => s !== sym) },
    });

  return (
    <div className="px-2 pt-1.5 pb-2 flex flex-col h-full">
      <div
        className="grid mb-2"
        style={{
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 3,
          padding: 3,
          borderRadius: 9,
          background: "var(--paper-2)",
          border: "1.5px solid var(--rule-softer)",
        }}
      >
        {(
          [
            { id: "stocks", n: "Stocks" },
            { id: "mfs", n: "Mutual funds" },
            { id: "etfs", n: "ETFs" },
          ] as const
        ).map((t) => {
          const on = tab === t.id;
          const pinnedCount = sel[t.id].length;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                if (t.id === tab) return;
                // Reset query + previous-tab results so MFs aren't queried
                // with a stocks symbol like "HDFCBANK" carried across.
                setQ("");
                setDebouncedQ("");
                setResults({ stocks: [], mfs: [], etfs: [] });
                setTab(t.id);
              }}
              className="inline-flex items-center justify-center gap-1.5 font-semibold"
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                background: on ? "var(--paper-2)" : "transparent",
                border: 0,
                color: on ? "var(--emerald-text)" : "var(--ink-3)",
                fontSize: 11.5,
                cursor: "pointer",
              }}
            >
              {t.n}
              {pinnedCount > 0 && (
                <span
                  className="font-mono font-bold"
                  style={{
                    fontSize: 9.5,
                    padding: "0 4px",
                    borderRadius: 3,
                    background: on
                      ? "rgba(52,211,153,0.15)"
                      : "var(--rule-softer)",
                    color: on ? "var(--emerald-text)" : "var(--ink-3)",
                  }}
                >
                  {pinnedCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        className="flex items-center gap-2 mb-2"
        style={{
          padding: "8px 10px",
          borderRadius: 10,
          background: "var(--paper)",
          border: "1.5px solid var(--rule-softer)",
        }}
      >
        <Search className="w-[13px] h-[13px] text-[var(--ink-3)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            tab === "stocks"
              ? "Search stocks…"
              : tab === "mfs"
                ? "Search MFs…"
                : "Search ETFs…"
          }
          className="flex-1 outline-none"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--ink)",
            fontSize: 12.5,
          }}
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            className="grid place-items-center"
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: "transparent",
              border: 0,
              color: "var(--ink-3)",
              cursor: "pointer",
            }}
          >
            <X className="w-[11px] h-[11px]" />
          </button>
        )}
      </div>

      {totalSel > 0 && (
        <div
          className="flex flex-wrap gap-1 mb-2"
          style={{
            padding: "7px 8px",
            borderRadius: 9,
            background: "var(--paper-2)",
            border: "1px solid rgba(52,211,153,0.15)",
          }}
        >
          <span
            className="font-mono uppercase font-bold"
            style={{
              fontSize: 9.5,
              color: "var(--emerald-text)",
              letterSpacing: 1,
              padding: "3px 5px",
            }}
          >
            In query
          </span>
          {[
            ...sel.stocks.map((s) => ({
              kind: "stocks" as const,
              sym: s,
              color: "#34d399",
            })),
            ...sel.mfs.map((s) => ({
              kind: "mfs" as const,
              sym: s,
              color: "#a78bfa",
            })),
            ...sel.etfs.map((s) => ({
              kind: "etfs" as const,
              sym: s,
              color: "#38bdf8",
            })),
          ].map((c) => (
            <span
              key={c.kind + c.sym}
              className="inline-flex items-center gap-1 font-mono font-semibold"
              style={{
                padding: "3px 4px 3px 7px",
                borderRadius: 5,
                background: "var(--paper-2)",
                border: `1px solid ${c.color}33`,
                fontSize: 10.5,
                color: "var(--ink)",
              }}
            >
              <span
                className="rounded-full"
                style={{ width: 5, height: 5, background: c.color }}
              />
              {c.sym}
              <button
                type="button"
                onClick={() => removeChip(c.kind, c.sym)}
                className="grid place-items-center"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: "transparent",
                  border: 0,
                  color: "var(--ink-3)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <X className="w-[9px] h-[9px]" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto -mx-0.5">
        {suggested.length > 0 && (
          <>
            <SectionLabel style={{ padding: "4px 6px 6px" }}>
              <span className="inline-flex items-center gap-1.5">
                <Star
                  className="w-2.5 h-2.5"
                  style={{
                    color: "var(--emerald-text)",
                    fill: "var(--emerald)",
                  }}
                />
                Recents · pinned
              </span>
            </SectionLabel>
            {suggested.map((it) => (
              <InstrumentRow
                key={it.sym}
                it={it}
                kind={tab}
                on={isSel(it)}
                onToggle={() => toggle(it)}
              />
            ))}
            <div
              className="h-px mx-1.5 my-2"
              style={{ background: "var(--paper-2)" }}
            />
          </>
        )}
        <SectionLabel style={{ padding: "4px 6px 6px" }}>
          {q
            ? `${items.length} match${items.length === 1 ? "" : "es"}`
            : tab === "stocks"
              ? "Popular stocks"
              : tab === "mfs"
                ? "Popular schemes"
                : "Popular ETFs"}
        </SectionLabel>
        {isLoading && items.length === 0 ? (
          <div className="text-center text-xs text-[var(--ink-3)] px-3 py-6">
            Searching…
          </div>
        ) : (
          rest.map((it) => (
            <InstrumentRow
              key={it.sym}
              it={it}
              kind={tab}
              on={isSel(it)}
              onToggle={() => toggle(it)}
            />
          ))
        )}
        {!isLoading && q && items.length === 0 && (
          <div className="text-center text-xs text-[var(--ink-3)] px-3 py-6">
            No{" "}
            {tab === "stocks"
              ? "stocks"
              : tab === "mfs"
                ? "mutual funds"
                : "ETFs"}{" "}
            match “{q}”.
          </div>
        )}
      </div>
    </div>
  );
}

function InstrumentRow({
  it,
  kind,
  on,
  onToggle,
}: {
  it: InstrumentItem;
  kind: "stocks" | "mfs" | "etfs";
  on: boolean;
  onToggle: () => void;
}) {
  // For stocks, the leading badge is the exchange (NSE / BSE) - picked
  // because the row sym/name already carry the symbol. Coloured emerald
  // for NSE, blue for BSE, with a neutral fallback for unknown exchanges.
  const stockExch = (it.exchange ?? "").toUpperCase();
  const symColor =
    kind === "stocks"
      ? stockExch === "NSE"
        ? "#34d399"
        : stockExch === "BSE"
          ? "#60a5fa"
          : "#94a3b8"
      : kind === "mfs"
        ? "#a78bfa"
        : "#38bdf8";
  const symBg =
    kind === "stocks"
      ? stockExch === "NSE"
        ? "var(--paper-2)"
        : stockExch === "BSE"
          ? "rgba(96,165,250,0.10)"
          : "rgba(148,163,184,0.10)"
      : kind === "mfs"
        ? "rgba(167,139,250,0.10)"
        : "rgba(56,189,248,0.10)";
  const badgeText =
    kind === "stocks" ? stockExch || "-" : kind === "mfs" ? "MF" : "ETF";

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2.5 mb-px"
      style={{
        padding: "8px 10px",
        borderRadius: 9,
        background: on ? "var(--paper-2)" : "transparent",
        border: 0,
        cursor: "pointer",
        color: "var(--ink)",
        textAlign: "left",
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
          color: "var(--paper)",
        }}
      >
        {on && <Check className="h-2.5 w-2.5" />}
      </span>
      <span
        className="inline-grid place-items-center font-mono font-bold shrink-0"
        style={{
          minWidth: 36,
          padding: "0 5px",
          height: 22,
          borderRadius: 5,
          background: symBg,
          color: symColor,
          fontSize: 9.5,
          letterSpacing: 0.3,
        }}
      >
        {badgeText}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span
            className="font-mono font-bold text-[var(--ink)]"
            style={{ fontSize: 11.5 }}
          >
            {it.sym}
          </span>
          <span
            className="text-[var(--ink-3)] truncate"
            style={{ fontSize: 11.5, maxWidth: 180 }}
          >
            {it.name}
          </span>
          {it.pinned && (
            <Pin
              className="w-2.5 h-2.5 ml-px"
              style={{
                color: "var(--emerald-text)",
                fill: "var(--emerald)",
              }}
            />
          )}
        </div>
        <div
          className="font-mono mt-0.5 flex gap-1.5 items-center flex-wrap"
          style={{ fontSize: 9.5 }}
        >
          {kind === "stocks" && (
            <>
              <span className="text-[var(--ink-3)]">{it.sector}</span>
              <span className="text-white/10">·</span>
              <span className="text-[var(--ink-3)]">MCap {it.mcap}</span>
            </>
          )}
          {kind === "mfs" && (
            <>
              <span className="text-[var(--ink-3)]">{it.kind}</span>
              <span className="text-white/10">·</span>
              <span className="text-[var(--ink-3)]">AUM ₹{it.aum}</span>
              <span className="text-white/10">·</span>
              <span className="inline-flex gap-px" style={{ color: "#fbbf24" }}>
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star
                    key={i}
                    className="w-2 h-2"
                    style={{
                      color: "#fbbf24",
                      fill: i < (it.rating ?? 0) ? "#fbbf24" : "transparent",
                    }}
                  />
                ))}
              </span>
            </>
          )}
          {kind === "etfs" && (
            <>
              <span className="text-[var(--ink-3)]">Tracks {it.bench}</span>
              <span className="text-white/10">·</span>
              <span className="text-[var(--ink-3)]">AUM ₹{it.aum}</span>
              <span
                className="font-mono"
                style={{
                  padding: "0 5px",
                  borderRadius: 3,
                  fontSize: 9,
                  background:
                    it.liquidity === "High"
                      ? "rgba(74,222,128,0.10)"
                      : it.liquidity === "Medium"
                        ? "rgba(251,191,36,0.10)"
                        : "rgba(248,113,113,0.10)",
                  color:
                    it.liquidity === "High"
                      ? "var(--semantic-positive-text)"
                      : it.liquidity === "Medium"
                        ? "var(--semantic-warning-text)"
                        : "var(--semantic-negative-text)",
                }}
              >
                {it.liquidity} liq
              </span>
            </>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div
          className="font-mono font-semibold text-[var(--ink)]"
          style={{ fontSize: 11.5 }}
        >
          {kind === "mfs" ? `₹${it.nav}` : `₹${it.px}`}
        </div>
        <div
          className="font-mono mt-px"
          style={{
            fontSize: 9.5,
            color: it.pos
              ? "var(--semantic-positive-text)"
              : "var(--semantic-negative-text)",
          }}
        >
          {it.chg}
        </div>
      </div>
    </button>
  );
}

// ─── Web view ───────────────────────────────────────────────────────────

function WebView({
  local,
  setLocal,
}: {
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  return (
    <div className="px-2 pt-1.5 pb-2">
      <div
        className="p-3"
        style={{
          borderRadius: 12,
          background: local.webSearch
            ? "rgba(56,189,248,0.06)"
            : "var(--paper)",
          border: `1px solid ${local.webSearch ? "rgba(56,189,248,0.22)" : "var(--rule-softer)"}`,
        }}
      >
        <div className="flex items-center gap-3">
          <span
            className="grid place-items-center shrink-0"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "rgba(56,189,248,0.10)",
              color: "#38bdf8",
            }}
          >
            <Globe className="w-[17px] h-[17px]" />
          </span>
          <div className="flex-1">
            <div className="text-[13.5px] font-semibold text-[var(--ink)]">
              Live web grounding
            </div>
            <div className="text-[11.5px] text-[var(--ink-3)] mt-0.5 leading-snug">
              Used on time-sensitive queries (news, filings, earnings days).
            </div>
          </div>
          <Toggle
            on={local.webSearch}
            onChange={(v) => setLocal({ webSearch: v })}
          />
        </div>
      </div>
      {local.webSearch && (
        <div className="px-1 pt-3 pb-1">
          <div className="flex justify-between mb-1.5">
            <span className="text-[11px] text-[var(--ink-3)]">This month</span>
            <span className="font-mono text-[11px] text-[var(--ink)]">
              <span style={{ color: "#38bdf8" }}>{local.webSearchUsed}</span> /{" "}
              {local.webSearchCap} searches
            </span>
          </div>
          <div
            className="overflow-hidden"
            style={{
              height: 6,
              borderRadius: 999,
              background: "var(--rule-softer)",
            }}
          >
            <div
              style={{
                width: `${(local.webSearchUsed / local.webSearchCap) * 100}%`,
                height: "100%",
                background: "linear-gradient(90deg,#38bdf8,#0ea5e9)",
              }}
            />
          </div>
          <p className="text-[10.5px] text-[var(--ink-3)] mt-2 leading-snug">
            Costs <span className="font-mono text-[var(--ink-3)]">1 cr</span>{" "}
            per use. Resets on the 1st.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Docs view ──────────────────────────────────────────────────────────

function DocsView({
  local,
  setLocal,
}: {
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  // The composer persists pinned doc ids as HASHED ints in
  // `local.docs` (composer.sources.activeDocumentIds). To preserve that
  // exact wiring while reusing the shared DocumentVaultPanel — which
  // speaks real string ids — we keep a real-id ⇄ hashed-int bridge here:
  // build the doc list locally, derive `selectedIds` (real ids whose
  // hash is pinned), and translate toggles back through hashStringToInt.
  const [docs, setDocs] = useState<VaultDocument[] | null>(null);

  const refreshDocs = useCallback(async () => {
    const res = await getDocumentsAction({ limit: 50 });
    if (!res.success || !res.data) {
      setDocs([]);
      return;
    }
    setDocs(
      res.data.documents.map((d) => ({
        id: d.id,
        title: d.title,
        fileName: d.fileName,
        fileSize: d.fileSize,
        documentType: d.documentType,
        processingStatus: d.processingStatus,
        createdAt: d.createdAt,
      }))
    );
  }, []);

  useEffect(() => {
    void refreshDocs();
  }, [refreshDocs]);

  if (docs === null) {
    return (
      <div className="py-12 text-center text-xs text-[var(--ink-3)]">
        Loading…
      </div>
    );
  }

  const pinned = new Set(local.docs);
  const selectedIds = docs
    .filter((d) => pinned.has(hashStringToInt(d.id)))
    .map((d) => d.id);

  const toggle = (realId: string) => {
    const h = hashStringToInt(realId);
    setLocal({
      docs: local.docs.includes(h)
        ? local.docs.filter((x) => x !== h)
        : [...local.docs, h],
    });
  };

  return (
    <div className="px-2 pt-1.5 pb-2">
      <DocumentVaultPanel
        documents={docs}
        selectedIds={selectedIds}
        onToggle={toggle}
        listMaxHeight={320}
        onUploaded={(docId) => {
          // Auto-pin the freshly-uploaded doc, then refresh the list.
          const h = hashStringToInt(docId);
          if (!local.docs.includes(h)) setLocal({ docs: [...local.docs, h] });
          void refreshDocs();
        }}
      />
    </div>
  );
}

// Hash a real document id into the legacy integer id space the composer
// persists in `composer.sources.activeDocumentIds`. Kept stable so the
// DocsView ⇄ DocumentVaultPanel bridge round-trips selections correctly.
function hashStringToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ─── Tools view ─────────────────────────────────────────────────────────

function ToolsView({
  tab,
  setTab,
  local,
  setLocal,
}: {
  tab: "indicators" | "screeners" | "strategies";
  setTab: (next: "indicators" | "screeners" | "strategies") => void;
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div
        className="flex gap-1 px-2 pt-2"
        style={{ borderBottom: "1.5px solid var(--rule-softer)" }}
      >
        {(
          [
            {
              id: "indicators",
              n: "Indicators",
              count: local.pinnedIndicators.length,
            },
            {
              id: "screeners",
              n: "Screeners",
              count: local.pinnedScreeners.length,
            },
            { id: "strategies", n: "Strategies", count: local.persona ? 1 : 0 },
          ] as const
        ).map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="inline-flex items-center gap-1.5 font-semibold"
              style={{
                padding: "8px 12px",
                background: "transparent",
                border: 0,
                color: on ? "var(--emerald-text)" : "var(--ink-3)",
                fontSize: 12,
                cursor: "pointer",
                borderBottom: `2px solid ${on ? "var(--emerald)" : "transparent"}`,
                marginBottom: -1,
              }}
            >
              {t.n}
              {t.count > 0 && (
                <span
                  className="font-mono font-bold"
                  style={{
                    fontSize: 9,
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: on
                      ? "rgba(52,211,153,0.12)"
                      : "var(--rule-softer)",
                    color: on ? "var(--emerald-text)" : "var(--ink-3)",
                  }}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "indicators" ? (
          <IndicatorsTab local={local} setLocal={setLocal} />
        ) : tab === "screeners" ? (
          <ScreenersTab local={local} setLocal={setLocal} />
        ) : (
          <StrategiesTab local={local} setLocal={setLocal} />
        )}
      </div>
    </div>
  );
}

function IndicatorsTab({
  local,
  setLocal,
}: {
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  const togglePin = (id: string) =>
    setLocal({
      pinnedIndicators: local.pinnedIndicators.includes(id)
        ? local.pinnedIndicators.filter((x) => x !== id)
        : [...local.pinnedIndicators, id],
    });

  const noneOn = local.pinnedIndicators.length === 0;

  return (
    <div className="p-2">
      <div
        className="flex items-center gap-2 mx-1 mb-2"
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          background: noneOn
            ? "rgba(74,222,128,0.05)"
            : "rgba(167,139,250,0.06)",
          border: `1px solid ${noneOn ? "rgba(74,222,128,0.18)" : "rgba(167,139,250,0.20)"}`,
          fontSize: 11,
          color: "var(--ink-3)",
        }}
      >
        {noneOn ? (
          <>
            <Check
              className="w-2.5 h-2.5"
              style={{ color: "var(--semantic-positive-text)" }}
            />
            <span>
              Default - <b className="text-[var(--ink)]">all 16 active</b> on
              /technical.
            </span>
          </>
        ) : (
          <>
            <Pin
              className="w-2.5 h-2.5"
              style={{ color: "#a78bfa", fill: "#a78bfa" }}
            />
            <span>
              Only the{" "}
              <b className="text-[var(--ink)]">
                {local.pinnedIndicators.length} pinned
              </b>{" "}
              will run on /technical.
            </span>
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {INDICATORS.map((ind) => {
          const pinned = local.pinnedIndicators.includes(ind.id);
          const fc = FAMILY_COLORS[ind.fam];
          return (
            <div
              key={ind.id}
              className="flex items-center gap-1.5"
              style={{
                padding: "8px 9px",
                borderRadius: 8,
                background: pinned ? "rgba(167,139,250,0.06)" : "var(--paper)",
                border: `1px solid ${pinned ? "rgba(167,139,250,0.25)" : "var(--rule-softer)"}`,
                opacity: ind.gated ? 0.45 : 1,
              }}
            >
              <div className="flex-1 min-w-0">
                <div
                  className="font-mono font-semibold tracking-tight text-[var(--ink)]"
                  style={{ fontSize: 11.5 }}
                >
                  {ind.n}
                </div>
                <span
                  className="inline-block mt-1 font-bold uppercase"
                  style={{
                    padding: "1px 6px",
                    borderRadius: 999,
                    fontSize: 8.5,
                    letterSpacing: 0.5,
                    background: `${fc}15`,
                    color: fc,
                  }}
                >
                  {ind.fam}
                </span>
              </div>
              <button
                type="button"
                onClick={() => !ind.gated && togglePin(ind.id)}
                disabled={ind.gated}
                title={
                  ind.gated
                    ? "Needs OHLCV. Connect a broker with full L2 data."
                    : pinned
                      ? "Unpin"
                      : "Pin"
                }
                className="grid place-items-center shrink-0"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: pinned ? "rgba(167,139,250,0.20)" : "transparent",
                  border: `1px solid ${pinned ? "rgba(167,139,250,0.35)" : "var(--rule-softer)"}`,
                  color: pinned ? "#a78bfa" : "var(--ink-3)",
                  cursor: ind.gated ? "not-allowed" : "pointer",
                }}
              >
                <Pin
                  className="w-2.5 h-2.5"
                  style={{ fill: pinned ? "#a78bfa" : "transparent" }}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScreenersTab(_props: {
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  // Coming soon - saved screener listing + per-row Run button is the
  // canonical surface this tab will hold once getScanHistoryAction is
  // wired (was hardcoded mock data before; that catalog has been removed
  // to avoid pretending the feature is live). Pinning persistence on
  // User.preferences.tools.pinnedScreenerIds is already in place so the
  // forward-compat contract is intact - just no rows to pin yet.
  return (
    <div className="px-3 py-8 flex flex-col items-center text-center">
      <span
        className="grid place-items-center w-11 h-11 rounded-xl mb-3"
        style={{
          background: "var(--paper-2)",
          border: "1px solid rgba(52,211,153,0.15)",
          color: "var(--emerald)",
        }}
      >
        <Filter className="h-5 w-5" />
      </span>
      <div className="text-sm font-semibold text-[var(--ink)] mb-1">
        Saved screeners - coming soon
      </div>
      <div className="text-[11.5px] text-[var(--ink-3)] leading-snug max-w-[260px] mb-4">
        Build screens on /strategies; pin the ones you run weekly so they show
        up here for one-click execution.
      </div>
      <a
        href="/strategies"
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-[var(--ink-3)] border"
        style={{
          background: "transparent",
          borderColor: "var(--rule-soft)",
        }}
      >
        Open /strategies
      </a>
    </div>
  );
}

function StrategiesTab({
  local,
  setLocal,
}: {
  local: LocalState;
  setLocal: (patch: Partial<LocalState>) => void;
}) {
  // Coming soon - Built-in (122) + From books + Personas + My custom
  // sub-sections are rendered in the design but each requires its own
  // backing service:
  //   - Built-in: import from BUILTIN_STRATEGIES in @usemoney/research
  //     (122 entries; needs virtualised list)
  //   - From books: editorial work (Greenblatt, Lynch, O'Neil, Buffett)
  //   - Personas: synthesizer prompt addenda (PERSONA_PROMPTS exists in
  //     composer-preferences.ts; planner-side wiring is a follow-up)
  //   - Custom: user-saved synthesizer prompts (storage not designed yet)
  //
  // Persona persistence on User.preferences.tools.persona is already in
  // place from commit b40f987, so the tab returning to a populated list
  // is a paste-the-data change later.
  return (
    <div className="px-3 py-8 flex flex-col items-center text-center">
      <span
        className="grid place-items-center w-11 h-11 rounded-xl mb-3"
        style={{
          background: "rgba(167,139,250,0.06)",
          border: "1px solid rgba(167,139,250,0.20)",
          color: "#a78bfa",
        }}
      >
        <UserCog className="h-5 w-5" />
      </span>
      <div className="text-sm font-semibold text-[var(--ink)] mb-1">
        Strategies & personas - coming soon
      </div>
      <div className="text-[11.5px] text-[var(--ink-3)] leading-snug max-w-[260px] mb-4">
        Built-in playbooks, book-based strategies (Greenblatt / Lynch /
        Buffett), investor personas (Marks / Damodaran / Jhunjhunwala) and your
        own custom prompts will live here.
      </div>
      <a
        href="/strategies"
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-[var(--ink-3)] border"
        style={{
          background: "transparent",
          borderColor: "var(--rule-soft)",
        }}
      >
        Open /strategies
      </a>
    </div>
  );
}

function StrategyCategory({
  title,
  badge,
  items,
  icon: IconCmp = Star,
}: {
  title: string;
  badge?: string;
  items: StrategyItem[];
  icon?: LucideIcon;
}) {
  return (
    <div className="mt-2">
      <div
        className="font-mono font-bold uppercase flex items-center gap-1.5 text-[var(--ink-3)]"
        style={{
          padding: "0 4px 6px",
          fontSize: 9.5,
          letterSpacing: 1.5,
        }}
      >
        {title}
        {badge && (
          <span
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 4,
              background: "var(--paper-2)",
              color: "var(--ink-3)",
              letterSpacing: 0.4,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {items.map((it) => (
        <div
          key={it.id}
          className="flex items-center gap-2 mb-0.5"
          style={{
            padding: "9px 10px",
            borderRadius: 8,
            background: "var(--paper)",
            border: "1.5px solid var(--rule-softer)",
          }}
        >
          <IconCmp className="w-3 h-3 text-[var(--ink-3)] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold text-[var(--ink)]">
              {it.n}
            </div>
            <div
              className="text-[var(--ink-3)] mt-0.5 leading-snug"
              style={{ fontSize: 10.5 }}
            >
              {it.t}
            </div>
          </div>
          <button
            type="button"
            className="font-semibold shrink-0"
            style={{
              padding: "4px 9px",
              borderRadius: 7,
              background: "var(--paper-2)",
              border: "1.5px solid var(--rule-soft)",
              color: "var(--ink-3)",
              fontSize: 10.5,
              cursor: "pointer",
            }}
          >
            Use
          </button>
        </div>
      ))}
    </div>
  );
}
