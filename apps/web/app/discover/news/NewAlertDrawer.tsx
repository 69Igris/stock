"use client";

/**
 * New Alert Drawer — playful right-side sheet on desktop, bottom sheet on mobile.
 * 4 steps: trigger type · condition (PfSymbolPicker single) · notify channels · cooldown.
 *
 * Design: §03 from pf-creators.jsx (playful design bundle).
 * Wiring preserved: createAlertAction, validation, prefilledSymbol, toast.
 * Symbol selector: PfSymbolPicker (single mode) wired to /api/market/autocomplete.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Bell,
  TrendingDown,
  BarChart3,
  Type,
  Calendar,
  Scissors,
  Code2,
  Monitor,
  Mail,
  Smartphone,
  MessageCircle,
  Loader2,
  Plus,
  Trash2,
  ChevronDown,
  Check,
  type LucideIcon,
  ShieldAlert,
  PackageCheck,
  Lock,
  UsersRound,
  Activity,
  ArrowLeftRight,
} from "lucide-react";
import { toast } from "sonner";
import {
  createAlertAction,
  type AlertKind,
  type NotifyChannel,
} from "@/lib/actions/alerts";
import {
  PfSymbolPicker,
  type SymbolOption,
} from "@/components/playful/PfSymbolPicker";
import styles from "./alert-drawer.module.css";

export type TriggerKind =
  | "price"
  | "volume"
  | "keyword"
  | "earnings"
  | "corp"
  | "custom"
  // MONEY-1204 / 14e.3 — data-engine triggers. Each reads a PRECOMPUTED table
  // (StockFlag, DailyPrice, ShareholdingPattern, InsiderEvent, MwplDaily,
  // InstitutionalFlow); none of them scrapes anything at evaluation time.
  | "flag"
  | "delivery"
  | "pledge"
  | "insider"
  | "mwpl"
  | "flow";

const TRIGGER_TO_KIND: Record<TriggerKind, AlertKind> = {
  price: "PRICE",
  volume: "VOLUME",
  keyword: "NEWS",
  earnings: "EARNINGS_DATE",
  corp: "CORPORATE_ACTION",
  custom: "CUSTOM",
  flag: "FLAG_TRANSITION",
  delivery: "DELIVERY_SPIKE",
  pledge: "PLEDGE_INCREASE",
  insider: "INSIDER_CLUSTER",
  mwpl: "MWPL_HIGH",
  flow: "FII_FLOW_STREAK",
};

const CHANNEL_TO_NOTIFY: Record<string, NotifyChannel> = {
  app: "IN_APP",
  email: "EMAIL",
  push: "PUSH",
};

const TRIGGER_TYPES: Array<{
  id: TriggerKind;
  Icon: LucideIcon;
  title: string;
  desc: string;
  pop: string;
}> = [
  {
    id: "price",
    Icon: TrendingDown,
    title: "Price cross",
    desc: "Above/below a threshold",
    pop: "var(--emerald)",
  },
  {
    id: "volume",
    Icon: BarChart3,
    title: "Volume spike",
    desc: "Multiple of avg volume",
    pop: "var(--pop-3)",
  },
  {
    id: "keyword",
    Icon: Type,
    title: "News keyword",
    desc: "Symbol + word combination",
    pop: "var(--pop-4)",
  },
  {
    id: "earnings",
    Icon: Calendar,
    title: "Earnings date",
    desc: "Reminder T-N days before",
    pop: "var(--pop-2)",
  },
  {
    id: "corp",
    Icon: Scissors,
    title: "Corporate action",
    desc: "Dividend, split, demerger",
    pop: "var(--pop-1)",
  },
  {
    id: "custom",
    Icon: Code2,
    title: "Custom rule",
    desc: "Combine fields + operators",
    pop: "var(--pop-5)",
  },
  // ── MONEY-1204 / 14e.3 — data-engine triggers ────────────────────────────
  {
    id: "flag",
    Icon: ShieldAlert,
    title: "Surveillance flag",
    desc: "ASM/GSM entry or exit, F&O ban, band change",
    pop: "var(--pop-1)",
  },
  {
    id: "delivery",
    Icon: PackageCheck,
    title: "Delivery spike",
    desc: "Over 2x the 20-day mean",
    pop: "var(--emerald)",
  },
  {
    id: "pledge",
    Icon: Lock,
    title: "Promoter pledge up",
    desc: "More than 2pp quarter on quarter",
    pop: "var(--pop-2)",
  },
  {
    id: "insider",
    Icon: UsersRound,
    title: "Insider cluster",
    desc: "3 or more insider buys in 30 days",
    pop: "var(--pop-3)",
  },
  {
    id: "mwpl",
    Icon: Activity,
    // Deliberately says "when NSE publishes it": MwplDaily.utilisationPct is
    // null on every row until an MWPL source exists, so this alert is armed and
    // dormant rather than broken. Promising a threshold we cannot compute would
    // be the lie; saying so is not.
    title: "MWPL utilisation",
    desc: "At or above 80% — active once NSE publishes the limit",
    pop: "var(--pop-4)",
  },
  {
    id: "flow",
    Icon: ArrowLeftRight,
    title: "FII/DII flow streak",
    desc: "5 straight net-buy or net-sell days",
    pop: "var(--pop-5)",
  },
];

interface ChannelDef {
  id: "app" | "email" | "push" | "wa";
  label: string;
  Icon: LucideIcon;
  pop: string;
  soon?: boolean;
}

const CHANNELS: ChannelDef[] = [
  { id: "app", label: "In-app", Icon: Monitor, pop: "var(--emerald)" },
  { id: "email", label: "Email", Icon: Mail, pop: "var(--pop-3)" },
  { id: "push", label: "Push", Icon: Smartphone, pop: "var(--pop-4)" },
  {
    id: "wa",
    label: "WhatsApp",
    Icon: MessageCircle,
    pop: "var(--pop-2)",
    soon: true,
  },
];

const COOLDOWN_OPTIONS = [
  { id: "15min", label: "15 min", minutes: 15 },
  { id: "60min", label: "60 min", minutes: 60 },
  { id: "1d", label: "Once / day", minutes: 1440 },
  { id: "once", label: "Once total", minutes: 0 },
] as const;

const CORP_ACTIONS = [
  { id: "DIVIDEND", label: "Dividend" },
  { id: "SPLIT", label: "Split" },
  { id: "BONUS", label: "Bonus" },
  { id: "BUYBACK", label: "Buyback" },
  { id: "DEMERGER", label: "Demerger" },
  { id: "RIGHTS", label: "Rights" },
] as const;

const CUSTOM_FIELDS = [
  { id: "price", label: "Price (₹)", kind: "number" },
  { id: "volume", label: "Volume × avg", kind: "number" },
  { id: "rsi", label: "RSI (14)", kind: "number" },
  { id: "macd", label: "MACD signal", kind: "enum" },
  { id: "pe", label: "P/E", kind: "number" },
  { id: "marketcap", label: "Market cap (Cr)", kind: "number" },
  { id: "mention", label: "News mentions", kind: "number" },
] as const;

type CustomField = (typeof CUSTOM_FIELDS)[number]["id"];

const CUSTOM_OPS: Record<"number" | "enum", string[]> = {
  number: [">", ">=", "<", "<=", "=", "crosses"],
  enum: ["is", "is not"],
};

interface CustomCondition {
  field: CustomField;
  op: string;
  value: string;
}

// ── MONEY-1204 · Step 2 for the data-engine triggers ────────────────────────
//
// Every condition key below is one the EVALUATOR ACTUALLY READS. A key it never
// reads saves fine, defaults silently, and looks configured — which is the bug
// this block exists to close. Each builder cites the exact read site in
// `workers/src/processors/alert-evaluator-logic.ts` (or its I/O shell
// `alert-evaluator.ts`), so the pairing can be re-checked without guessing.

/** The controls the generic data-engine panel can render, keyed by draft field. */
type NumberFieldKey =
  | "deliveryMultiplier"
  | "pledgeMinDeltaPp"
  | "insiderMinEvents"
  | "insiderWindowDays"
  | "mwplThreshold"
  | "flowMinDays";

type ChoiceFieldKey = "flowCategory" | "flowDirection";

interface NumberFieldSpec {
  control: "number";
  key: NumberFieldKey;
  label: string;
  suffix?: string;
}

interface ChoiceFieldSpec {
  control: "choice";
  key: ChoiceFieldKey;
  label: string;
  options: ReadonlyArray<{ id: string; label: string }>;
}

interface MultiFieldSpec {
  control: "multi";
  key: "flagKinds";
  label: string;
  options: ReadonlyArray<{ id: string; label: string }>;
}

type FieldSpec = NumberFieldSpec | ChoiceFieldSpec | MultiFieldSpec;

/**
 * "bespoke" = this trigger renders its own hand-written Step 2 block below.
 * Anything else declares its controls as DATA, so a trigger can never end up
 * with a blank condition panel just because nobody wrote the JSX.
 */
type PanelSpec = "bespoke" | { fields: readonly FieldSpec[] };

/** The Step 2 values for the six data-engine triggers. */
export interface DataEngineDraft {
  flagKinds: string[];
  deliveryMultiplier: string;
  pledgeMinDeltaPp: string;
  insiderMinEvents: string;
  insiderWindowDays: string;
  mwplThreshold: string;
  /** "FII" | "DII" — read by the evaluator SHELL, not the pure logic. */
  flowCategory: string;
  flowMinDays: string;
  /** "ANY" | "BUY" | "SELL" — "ANY" omits `directions` entirely. */
  flowDirection: string;
}

/** Everything Step 2 can collect, flattened so every builder stays pure. */
export interface ConditionDraft extends DataEngineDraft {
  priceOp: "above" | "below" | "crosses";
  priceThreshold: string;
  volMultiplier: string;
  keywordText: string;
  daysBefore: string;
  corpActions: string[];
  customConditions: CustomCondition[];
  customCombinator: "AND" | "OR";
}

/**
 * Seeded to the EVALUATOR'S OWN DEFAULTS so the form shows the truth:
 * MWPL_HIGH_THRESHOLD_PCT = 80, INSIDER_CLUSTER_MIN_EVENTS = 3 /
 * INSIDER_CLUSTER_WINDOW_DAYS = 30, FLOW_STREAK_MIN_DAYS = 5, delivery
 * multiplier 2, pledge minDeltaPp 2, and DEFAULT_FLAG_KINDS for the flags —
 * which `alert-drawer-conditions.test.ts` pins against the evaluator's own
 * exported constant, so a change there shows up here as a failing test rather
 * than as a form that quietly lies about what it will watch.
 */
export const DEFAULT_DATA_ENGINE_DRAFT: DataEngineDraft = {
  flagKinds: [
    "SURVEILLANCE",
    "FO_BAN",
    "PRICE_BAND",
    "BAND_CHANGE",
    "SERIES_CHANGE",
  ],
  deliveryMultiplier: "2",
  pledgeMinDeltaPp: "2",
  insiderMinEvents: "3",
  insiderWindowDays: "30",
  mwplThreshold: "80",
  flowCategory: "FII",
  flowMinDays: "5",
  flowDirection: "ANY",
};

/**
 * Flag kinds offered to the user.
 *
 * WK52_HIGH_LOW and SHORT_SELLING are deliberately NOT offered: NSE publishes
 * them for essentially the whole universe every session, so watching one means
 * a notification every trading day forever — the same reason the evaluator's
 * FLAG_KIND_POLICY marks them `watchedByDefault: false` and exports them as
 * OPT_IN_FLAG_KINDS rather than dropping them.
 */
const FLAG_KIND_OPTIONS = [
  { id: "SURVEILLANCE", label: "Surveillance" },
  { id: "FO_BAN", label: "F&O ban" },
  { id: "PRICE_BAND", label: "Price band" },
  { id: "BAND_CHANGE", label: "Band change" },
  { id: "SERIES_CHANGE", label: "Series change" },
] as const;

const FLOW_CATEGORY_OPTIONS = [
  { id: "FII", label: "FII" },
  { id: "DII", label: "DII" },
] as const;

const FLOW_DIRECTION_OPTIONS = [
  { id: "ANY", label: "Either" },
  { id: "BUY", label: "Net buy" },
  { id: "SELL", label: "Net sell" },
] as const;

function flagKindLabel(id: string): string {
  return FLAG_KIND_OPTIONS.find((f) => f.id === id)?.label ?? id;
}

/**
 * A finite, strictly-positive number, or null.
 *
 * The evaluator's `numberOption` IGNORES anything that is not a finite number
 * and falls back to its hardcoded default.
 * So a blank or junk field must BLOCK THE SAVE here rather than sail through
 * and quietly become a default the user never chose.
 */
function positiveNumber(raw: string): number | null {
  const n = Number.parseFloat(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** As {@link positiveNumber}, but for counts (events, days). */
function positiveInt(raw: string): number | null {
  const n = positiveNumber(raw);
  if (n === null) return null;
  const i = Math.round(n);
  return i > 0 ? i : null;
}

interface TriggerSpec {
  /**
   * Does this trigger address ONE instrument? FII_FLOW_STREAK is market-wide
   * (InstitutionalFlow has no symbol column at all) and CUSTOM is free-form, so
   * neither may be blocked on a symbol — and every other trigger MUST be.
   */
  needsSymbol: boolean;
  panel: PanelSpec;
  /** null = the user has not finished configuring; the save is refused. */
  build: (d: ConditionDraft) => Record<string, unknown> | null;
  summary: (d: ConditionDraft, symbol: string) => string;
}

/**
 * The trigger → {symbol rule, panel, conditions, summary} map.
 *
 * `Record<TriggerKind, TriggerSpec>` is the point: adding a 13th TriggerKind
 * fails the BUILD here (and in TRIGGER_TO_KIND) instead of silently falling
 * through to the custom-rule builder, which is exactly how six triggers
 * shipped saving `price>2800 AND volume>2` on a symbol nobody picked.
 */
export const TRIGGER_SPECS: Record<TriggerKind, TriggerSpec> = {
  price: {
    needsSymbol: true,
    panel: "bespoke",
    build: (d) => ({
      direction: d.priceOp,
      threshold: parseFloat(d.priceThreshold) || 0,
    }),
    summary: (d, s) => `${s} ${d.priceOp} ₹${d.priceThreshold || "—"}`,
  },
  volume: {
    needsSymbol: true,
    panel: "bespoke",
    build: (d) => ({ multiplier: parseFloat(d.volMultiplier) || 1 }),
    summary: (d, s) => `${s} volume ≥ ${d.volMultiplier || "—"}× 30d avg`,
  },
  keyword: {
    // evaluateNews returns early on a null symbol, so a keyword alert without
    // one would never fire.
    needsSymbol: true,
    panel: "bespoke",
    build: (d) =>
      d.keywordText.trim() ? { keyword: d.keywordText.trim() } : null,
    summary: (d, s) =>
      d.keywordText.trim()
        ? `${s || "Any symbol"} + "${d.keywordText}"`
        : "Add a keyword",
  },
  earnings: {
    needsSymbol: true,
    panel: "bespoke",
    build: (d) => ({ daysBefore: parseInt(d.daysBefore, 10) || 1 }),
    summary: (d, s) => `${s} earnings · T-${d.daysBefore || "0"} days`,
  },
  corp: {
    needsSymbol: true,
    panel: "bespoke",
    build: (d) =>
      d.corpActions.length === 0 ? null : { actions: d.corpActions },
    summary: (d, s) =>
      d.corpActions.length === 0
        ? "Pick an action"
        : `${s} → ${d.corpActions.map(prettyAction).join(" / ")}`,
  },
  custom: {
    needsSymbol: false,
    panel: "bespoke",
    build: (d) =>
      d.customConditions.length === 0
        ? null
        : {
            combinator: d.customCombinator,
            rules: d.customConditions.map((c) => ({
              field: c.field,
              op: c.op,
              value:
                CUSTOM_FIELDS.find((f) => f.id === c.field)?.kind === "number"
                  ? parseFloat(c.value) || 0
                  : c.value,
            })),
          },
    summary: (d, s) => {
      if (d.customConditions.length === 0) return "Add at least one condition";
      const parts = d.customConditions
        .filter((c) => c.value.trim().length > 0)
        .map((c) => `${fieldLabel(c.field)} ${c.op} ${c.value}`);
      if (parts.length === 0) return "Fill in condition values";
      const target = s.trim() || "Any symbol";
      return `${target} · ${parts.join(` ${d.customCombinator} `)}`;
    },
  },

  // ── MONEY-1204 / 14e.3 — data-engine triggers ─────────────────────────────
  flag: {
    needsSymbol: true,
    panel: {
      fields: [
        {
          control: "multi",
          key: "flagKinds",
          label: "Watch",
          options: FLAG_KIND_OPTIONS,
        },
      ],
    },
    // `kinds` ← stringArrayOption(conditions, "kinds") in
    // evaluateFlagTransition. With none written the evaluator fell back to
    // DEFAULT_FLAG_KINDS and the user's choice was a no-op.
    build: (d) =>
      d.flagKinds.length === 0 ? null : { kinds: [...d.flagKinds] },
    summary: (d, s) =>
      d.flagKinds.length === 0
        ? "Pick at least one flag"
        : `${s} · ${d.flagKinds.map(flagKindLabel).join(" / ")}`,
  },
  delivery: {
    needsSymbol: true,
    panel: {
      fields: [
        {
          control: "number",
          key: "deliveryMultiplier",
          label: "Spike over",
          suffix: "× 20d mean",
        },
      ],
    },
    // `multiplier` ← numberOption(conditions, "multiplier") in
    // evaluateDeliverySpike, default 2. `minContributingDays` is deliberately
    // NOT exposed: it is a baseline-honesty guard, not a user knob.
    build: (d) => {
      const multiplier = positiveNumber(d.deliveryMultiplier);
      return multiplier === null ? null : { multiplier };
    },
    summary: (d, s) =>
      `${s} delivery > ${d.deliveryMultiplier || "—"}× 20d mean`,
  },
  pledge: {
    needsSymbol: true,
    panel: {
      fields: [
        {
          control: "number",
          key: "pledgeMinDeltaPp",
          label: "Pledge up by",
          suffix: "pp QoQ",
        },
      ],
    },
    // `minDeltaPp` ← numberOption(conditions, "minDeltaPp") in
    // evaluatePledgeIncrease, default 2. Percentage POINTS, not percent.
    build: (d) => {
      const minDeltaPp = positiveNumber(d.pledgeMinDeltaPp);
      return minDeltaPp === null ? null : { minDeltaPp };
    },
    summary: (d, s) =>
      `${s} promoter pledge up > ${d.pledgeMinDeltaPp || "—"}pp QoQ`,
  },
  insider: {
    needsSymbol: true,
    panel: {
      fields: [
        {
          control: "number",
          key: "insiderMinEvents",
          label: "Buys",
          suffix: "or more",
        },
        {
          control: "number",
          key: "insiderWindowDays",
          label: "Within",
          suffix: "days",
        },
      ],
    },
    // `minEvents` / `windowDays` ← numberOption(...) in
    // evaluateInsiderCluster, defaults 3 / 30. `categories` is left unset = all.
    build: (d) => {
      const minEvents = positiveInt(d.insiderMinEvents);
      const windowDays = positiveInt(d.insiderWindowDays);
      if (minEvents === null || windowDays === null) return null;
      return { minEvents, windowDays };
    },
    summary: (d, s) =>
      `${s} · ${d.insiderMinEvents || "—"}+ insider buys in ${d.insiderWindowDays || "—"} days`,
  },
  mwpl: {
    needsSymbol: true,
    panel: {
      fields: [
        {
          control: "number",
          key: "mwplThreshold",
          label: "Utilisation at least",
          suffix: "%",
        },
      ],
    },
    // `threshold` ← numberOption(conditions, "threshold") in evaluateMwplHigh,
    // default MWPL_HIGH_THRESHOLD_PCT = 80.
    build: (d) => {
      const threshold = positiveNumber(d.mwplThreshold);
      return threshold === null ? null : { threshold };
    },
    summary: (d, s) => `${s} MWPL ≥ ${d.mwplThreshold || "—"}%`,
  },
  flow: {
    // MARKET-WIDE: InstitutionalFlow carries no symbol, and the shell's
    // evaluateDataEngineAlert never looks at alert.symbol for this kind.
    needsSymbol: false,
    panel: {
      fields: [
        {
          control: "choice",
          key: "flowCategory",
          label: "Whose flow",
          options: FLOW_CATEGORY_OPTIONS,
        },
        {
          control: "number",
          key: "flowMinDays",
          label: "Streak of",
          suffix: "days",
        },
        {
          control: "choice",
          key: "flowDirection",
          label: "Direction",
          options: FLOW_DIRECTION_OPTIONS,
        },
      ],
    },
    // `category` ← the I/O shell's evaluateDataEngineAlert (defaults "FII"),
    // which uses it to pick the InstitutionalFlow rows; `minDays` ←
    // numberOption(conditions, "minDays"), default FLOW_STREAK_MIN_DAYS = 5;
    // `directions` ← stringArrayOption(conditions, "directions") — omitted for
    // "ANY", because an EMPTY array there reads as "no filter" only by accident.
    build: (d) => {
      const minDays = positiveInt(d.flowMinDays);
      if (minDays === null) return null;
      const category = d.flowCategory === "DII" ? "DII" : "FII";
      const conditions: Record<string, unknown> = { category, minDays };
      if (d.flowDirection === "BUY" || d.flowDirection === "SELL") {
        conditions.directions = [d.flowDirection];
      }
      return conditions;
    },
    summary: (d) =>
      `${d.flowCategory} net ${
        d.flowDirection === "BUY"
          ? "buying"
          : d.flowDirection === "SELL"
            ? "selling"
            : "buying or selling"
      } ${d.flowMinDays || "—"} days running`,
  },
};

/** The 12 trigger ids, for table-driven callers and tests. */
export const TRIGGER_KINDS = Object.keys(TRIGGER_SPECS) as TriggerKind[];

/**
 * The ONLY way conditions are built. Exported so a test can hold every trigger
 * to the evaluator's real key names without rendering the drawer.
 */
export function buildAlertConditions(
  trigger: TriggerKind,
  draft: ConditionDraft
): Record<string, unknown> | null {
  return TRIGGER_SPECS[trigger].build(draft);
}

/** Does this trigger require a symbol the user actually chose? */
export function triggerNeedsSymbol(trigger: TriggerKind): boolean {
  return TRIGGER_SPECS[trigger].needsSymbol;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  prefilledSymbol?: string;
}

export default function NewAlertDrawer({
  open,
  onClose,
  onCreated,
  prefilledSymbol,
}: Props) {
  const [trigger, setTrigger] = useState<TriggerKind>("price");
  /**
   * EMPTY, not a sample.
   *
   * This used to seed RELIANCE, which meant `symbol` was never blank, the
   * "Pick a symbol" guard always passed, and any trigger whose panel showed no
   * picker saved an alert on a symbol the user had never seen — with a success
   * toast. A seeded symbol cannot be told apart from a chosen one, so the seed
   * had to go rather than the guard get smarter.
   */
  const [symbolOpts, setSymbolOpts] = useState<SymbolOption[]>([]);

  useEffect(() => {
    if (open && prefilledSymbol && prefilledSymbol.trim()) {
      setSymbolOpts([
        {
          sym: prefilledSymbol.toUpperCase(),
          exch: "NSE",
          kind: "EQUITY",
        },
      ]);
    }
  }, [open, prefilledSymbol]);

  /** Derived string symbol for all business logic */
  const symbol = symbolOpts[0]?.sym ?? "";

  /** Bridge to /api/market/autocomplete for PfSymbolPicker */
  const fetchSymbols = useCallback(
    async (q: string): Promise<SymbolOption[]> => {
      if (!q || q.trim().length < 1) return [];
      try {
        const res = await fetch(
          `/api/market/autocomplete?q=${encodeURIComponent(q)}&limit=8`,
          { cache: "no-store" }
        );
        if (!res.ok) return [];
        const json = (await res.json()) as {
          success?: boolean;
          results?: Array<{
            symbol: string;
            name: string;
            type?: string;
            exchange?: string;
          }>;
        };
        return (json.results ?? []).map((r) => ({
          sym: r.symbol,
          exch: r.exchange ?? "NSE",
          kind: r.type ?? "EQUITY",
          name: r.name,
        }));
      } catch {
        return [];
      }
    },
    []
  );

  const [priceOp, setPriceOp] = useState<"above" | "below" | "crosses">(
    "below"
  );
  const [priceThreshold, setPriceThreshold] = useState("2800");
  const [volMultiplier, setVolMultiplier] = useState("2.0");
  const [keywordText, setKeywordText] = useState("");
  const [daysBefore, setDaysBefore] = useState("1");
  const [corpActions, setCorpActions] = useState<string[]>(["DIVIDEND"]);
  const [customConditions, setCustomConditions] = useState<CustomCondition[]>([
    { field: "price", op: ">", value: "2800" },
    { field: "volume", op: ">", value: "2" },
  ]);
  const [customCombinator, setCustomCombinator] = useState<"AND" | "OR">("AND");
  // MONEY-1204 — Step 2 values for the six data-engine triggers, in ONE bag so
  // the generic panel can read/write them by key.
  const [dataEngine, setDataEngine] = useState<DataEngineDraft>(
    DEFAULT_DATA_ENGINE_DRAFT
  );
  const [channels, setChannels] = useState<string[]>(["app", "email"]);
  const [cooldown, setCooldown] = useState<string>("60min");
  const [saving, setSaving] = useState(false);
  const [condOpen, setCondOpen] = useState(false);
  const condRef = useRef<HTMLDivElement>(null);

  /* Close condition dropdown on outside click */
  useEffect(() => {
    if (!condOpen) return;
    function handleOutside(e: MouseEvent) {
      if (condRef.current && !condRef.current.contains(e.target as Node)) {
        setCondOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [condOpen]);

  if (!open) return null;

  const toggleChannel = (id: string) =>
    setChannels((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const toggleCorpAction = (id: string) =>
    setCorpActions((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const patchDataEngine = (p: Partial<DataEngineDraft>) =>
    setDataEngine((prev) => ({ ...prev, ...p }));

  const toggleFlagKind = (id: string) =>
    setDataEngine((prev) => ({
      ...prev,
      flagKinds: prev.flagKinds.includes(id)
        ? prev.flagKinds.filter((x) => x !== id)
        : [...prev.flagKinds, id],
    }));

  /** Every Step 2 value, in the shape the pure builders take. */
  const draft: ConditionDraft = {
    priceOp,
    priceThreshold,
    volMultiplier,
    keywordText,
    daysBefore,
    corpActions,
    customConditions,
    customCombinator,
    ...dataEngine,
  };

  const spec = TRIGGER_SPECS[trigger];

  const summaryLine = (): string => {
    if (spec.needsSymbol && !symbol.trim()) return "Pick a symbol";
    return spec.summary(draft, symbol);
  };

  /**
   * ONE lookup, no if-chain: `TRIGGER_SPECS` is a `Record<TriggerKind, …>`, so
   * a trigger with no builder cannot compile, let alone fall through to the
   * custom-rule builder and save somebody's "Insider cluster" as
   * `price>2800 AND volume>2`.
   */
  const buildConditions = (): Record<string, unknown> | null =>
    spec.build(draft);

  const handleSave = async () => {
    // Per-trigger, from the same total record — FII_FLOW_STREAK is market-wide
    // and CUSTOM is free-form, everything else needs a REAL chosen symbol.
    if (spec.needsSymbol && !symbol.trim()) {
      toast.error("Pick a symbol");
      return;
    }
    const conditions = buildConditions();
    if (!conditions) {
      toast.error("Condition is incomplete");
      return;
    }
    setSaving(true);
    try {
      const cooldownDef = COOLDOWN_OPTIONS.find((c) => c.id === cooldown);
      const notifyChannels = channels
        .map((c) => CHANNEL_TO_NOTIFY[c])
        .filter((c): c is NotifyChannel => Boolean(c));
      const result = await createAlertAction({
        kind: TRIGGER_TO_KIND[trigger],
        // undefined -> stored as null. The old `|| "ANY"` wrote a fake ticker
        // for the symbol-less kinds.
        symbol: symbol.trim().toUpperCase() || undefined,
        conditions,
        notifyChannels,
        cooldownMinutes: cooldownDef?.minutes ?? 60,
      });
      if (result?.success) {
        toast.success(`Alert created · ${summaryLine()}`);
        onCreated?.();
        onClose();
      } else {
        toast.error(result?.error ?? "Couldn't save alert");
      }
    } finally {
      setSaving(false);
    }
  };

  // derive summary parts for FIRE WHEN codeblock
  const triggerDef = TRIGGER_TYPES.find((t) => t.id === trigger);
  const condSym = symbol || (spec.needsSymbol ? "SYMBOL" : "MARKET");
  const condOp =
    trigger === "price"
      ? priceOp.toUpperCase()
      : trigger === "volume"
        ? "≥"
        : "WHEN";
  const condVal =
    trigger === "price"
      ? `₹${priceThreshold || "—"}`
      : trigger === "volume"
        ? `${volMultiplier || "—"}× AVG`
        : trigger === "earnings"
          ? `T-${daysBefore}D`
          : trigger === "corp"
            ? corpActions.join(", ") || "—"
            : trigger === "keyword"
              ? `"${keywordText || "…"}"`
              : "...";

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15,13,8,0.55)",
          backdropFilter: "blur(2px)",
          zIndex: 80,
        }}
      />

      {/* Sheet — right on ≥sm, bottom on mobile */}
      <div className={styles.sheet}>
        {/* Drag handle (mobile only) */}
        <div className={styles.dragHandle} />

        {/* ── Header ──────────────────────────────────────────── */}
        <div className={styles.header}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "var(--pop-1)",
              border: "1.5px solid var(--ink)",
              display: "grid",
              placeItems: "center",
              transform: "rotate(-4deg)",
              boxShadow: "2.5px 2.5px 0 var(--ink)",
              flexShrink: 0,
            }}
          >
            <Bell size={17} strokeWidth={2.25} color="var(--paper)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 17,
                fontWeight: 800,
                color: "var(--ink)",
                letterSpacing: -0.4,
                lineHeight: 1.15,
              }}
            >
              New alert
            </div>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                color: "var(--ink-3)",
                letterSpacing: 1.3,
                marginTop: 2,
                textTransform: "uppercase",
              }}
            >
              Step 1 / 4 · Trigger
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 32,
              height: 32,
              border: "1.5px solid var(--ink)",
              background: "var(--paper)",
              borderRadius: 8,
              color: "var(--ink)",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
            }}
          >
            <X size={14} strokeWidth={2.25} />
          </button>
        </div>

        {/* ── Body (scrollable) ────────────────────────────────── */}
        <div className={styles.body}>
          {/* Step 1 — Trigger type */}
          <StepLabel n={1} label="Trigger type" />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginBottom: 22,
            }}
          >
            {TRIGGER_TYPES.map((t) => {
              const active = trigger === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTrigger(t.id)}
                  style={{
                    background: active ? "var(--ink)" : "var(--paper)",
                    color: active ? "var(--paper)" : "var(--ink)",
                    border: "1.75px solid var(--ink)",
                    borderRadius: 10,
                    padding: "11px 12px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    boxShadow: active ? "3px 3px 0 var(--emerald)" : "none",
                    transform: active ? "translate(-1px,-1px)" : "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    position: "relative",
                    transition: "box-shadow 0.1s, transform 0.1s",
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      background: active ? "var(--emerald)" : t.pop,
                      border:
                        "1.25px solid " +
                        (active ? "var(--paper)" : "var(--ink)"),
                      display: "grid",
                      placeItems: "center",
                      transform: "rotate(-3deg)",
                      flexShrink: 0,
                    }}
                  >
                    <t.Icon size={13} strokeWidth={2.25} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: -0.1,
                        lineHeight: 1.15,
                      }}
                    >
                      {t.title}
                    </div>
                    <div
                      className="ser"
                      style={{
                        fontSize: 11.5,
                        color: active ? "var(--paper)" : "var(--ink-3)",
                        marginTop: 2,
                        lineHeight: 1.2,
                      }}
                    >
                      {t.desc}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Step 2 — Condition */}
          <StepLabel
            n={2}
            label={trigger === "custom" ? "Rule builder" : "Condition"}
          />

          {trigger === "price" && (
            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              {/* Symbol row */}
              <PfSymbolPicker
                mode="single"
                value={symbolOpts}
                onChange={setSymbolOpts}
                fetchSymbols={fetchSymbols}
                placeholder="Search a symbol"
              />
              {/* Condition row: dropdown + value — flex-wrap so it never causes h-scroll */}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {/* Custom playful condition dropdown */}
                <div
                  ref={condRef}
                  style={{ position: "relative", flex: "1 1 120px" }}
                >
                  <button
                    type="button"
                    onClick={() => setCondOpen((o) => !o)}
                    style={{
                      width: "100%",
                      padding: "11px 14px",
                      height: 44,
                      background: "var(--paper)",
                      color: "var(--ink)",
                      border: "1.5px solid var(--ink)",
                      borderRadius: 9,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 13,
                      fontWeight: 700,
                      letterSpacing: 1,
                      boxShadow: condOpen ? "3px 3px 0 var(--ink)" : "none",
                      transform: condOpen ? "translate(-1px,-1px)" : "none",
                    }}
                  >
                    <span style={{ flex: 1, textAlign: "left" }}>
                      {priceOp.toUpperCase()}
                    </span>
                    <ChevronDown size={12} color="var(--ink-3)" />
                  </button>
                  {condOpen && (
                    <div
                      style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 0,
                        right: 0,
                        zIndex: 30,
                        background: "var(--paper)",
                        border: "1.5px solid var(--ink)",
                        borderRadius: 9,
                        boxShadow: "3px 3px 0 var(--ink)",
                        overflow: "hidden",
                      }}
                    >
                      {(
                        [
                          ["above", "above"],
                          ["below", "below"],
                          ["crosses", "crosses"],
                        ] as const
                      ).map(([k, l], i) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            setPriceOp(k);
                            setCondOpen(false);
                          }}
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            background:
                              priceOp === k ? "var(--paper-3)" : "transparent",
                            border: 0,
                            borderBottom:
                              i < 2 ? "1px dashed var(--rule-soft)" : "none",
                            cursor: "pointer",
                            textAlign: "left",
                            fontFamily: "Inter, sans-serif",
                            fontSize: 13,
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            color: "var(--ink)",
                          }}
                        >
                          {priceOp === k && (
                            <Check size={11} color="var(--emerald-text)" />
                          )}
                          <span style={{ marginLeft: priceOp === k ? 0 : 18 }}>
                            {l}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Threshold input */}
                <input
                  value={priceThreshold}
                  onChange={(e) => setPriceThreshold(e.target.value)}
                  placeholder="Threshold ₹"
                  inputMode="decimal"
                  className="pf-input mono"
                  style={{
                    flex: "1 1 100px",
                    fontSize: 12.5,
                    textAlign: "right",
                    height: 44,
                  }}
                />
              </div>
            </div>
          )}

          {trigger === "volume" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 140px",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <PfSymbolPicker
                mode="single"
                value={symbolOpts}
                onChange={setSymbolOpts}
                fetchSymbols={fetchSymbols}
                placeholder="Search a symbol"
              />
              <div style={{ position: "relative" }}>
                <input
                  value={volMultiplier}
                  onChange={(e) => setVolMultiplier(e.target.value)}
                  inputMode="decimal"
                  placeholder="2.0"
                  className="pf-input mono"
                  style={{ paddingRight: 40, fontSize: 12.5 }}
                />
                <span
                  className="mono"
                  style={{
                    position: "absolute",
                    right: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    fontSize: 11,
                    color: "var(--ink-3)",
                    pointerEvents: "none",
                  }}
                >
                  × avg
                </span>
              </div>
            </div>
          )}

          {trigger === "keyword" && (
            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              {/* evaluateNews returns early on a null symbol, so the old "Any
                  symbol / or pick one" was never true for this trigger — and
                  with the RELIANCE seed gone it would send users looking for an
                  option that does not exist. */}
              <PfSymbolPicker
                mode="single"
                value={symbolOpts}
                onChange={setSymbolOpts}
                fetchSymbols={fetchSymbols}
                placeholder="Search a symbol"
              />
              <input
                value={keywordText}
                onChange={(e) => setKeywordText(e.target.value)}
                placeholder="e.g. layoffs, ARPU, downgrade"
                className="pf-input"
                style={{ fontSize: 13 }}
              />
            </div>
          )}

          {trigger === "earnings" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 140px",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <PfSymbolPicker
                mode="single"
                value={symbolOpts}
                onChange={setSymbolOpts}
                fetchSymbols={fetchSymbols}
                placeholder="Search a symbol"
              />
              <select
                value={daysBefore}
                onChange={(e) => setDaysBefore(e.target.value)}
                className="pf-input mono"
                style={{ fontSize: 12.5 }}
              >
                <option value="1">T-1 day</option>
                <option value="3">T-3 days</option>
                <option value="7">T-7 days</option>
              </select>
            </div>
          )}

          {trigger === "corp" && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ marginBottom: 8 }}>
                <PfSymbolPicker
                  mode="single"
                  value={symbolOpts}
                  onChange={setSymbolOpts}
                  fetchSymbols={fetchSymbols}
                  placeholder="Search a symbol"
                />
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 8,
                }}
              >
                {CORP_ACTIONS.map((a) => {
                  const on = corpActions.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      onClick={() => toggleCorpAction(a.id)}
                      className="mono"
                      style={{
                        padding: "9px 10px",
                        background: on ? "var(--ink)" : "var(--paper)",
                        color: on ? "var(--paper)" : "var(--ink)",
                        border: "1.5px solid var(--ink)",
                        borderRadius: 8,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: "pointer",
                        boxShadow: on ? "2.5px 2.5px 0 var(--emerald)" : "none",
                        transform: on ? "translate(-1px,-1px)" : "none",
                        transition: "box-shadow 0.1s, transform 0.1s",
                      }}
                    >
                      {a.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {trigger === "custom" && (
            <CustomRuleBuilder
              symbolOpts={symbolOpts}
              onSymbolOptsChange={setSymbolOpts}
              fetchSymbols={fetchSymbols}
              conditions={customConditions}
              onChange={setCustomConditions}
              combinator={customCombinator}
              onCombinatorChange={setCustomCombinator}
            />
          )}

          {/* MONEY-1204 — the data-engine triggers. Their controls are declared
              as DATA on TRIGGER_SPECS, so the panel is rendered from the same
              total record the conditions are built from: a trigger cannot get a
              builder and no panel, or a panel and no builder. */}
          {spec.panel !== "bespoke" && (
            <DataEngineConditionPanel
              fields={spec.panel.fields}
              values={dataEngine}
              needsSymbol={spec.needsSymbol}
              symbolOpts={symbolOpts}
              onSymbolOptsChange={setSymbolOpts}
              fetchSymbols={fetchSymbols}
              onPatch={patchDataEngine}
              onToggleFlagKind={toggleFlagKind}
            />
          )}

          {/* FIRE WHEN terminal preview */}
          <div
            className="pf-codeblock"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 22,
              letterSpacing: 1.2,
              flexWrap: "wrap",
            }}
          >
            <span className="em" style={{ fontSize: 11 }}>
              FIRE WHEN
            </span>
            {spec.panel === "bespoke" ? (
              <>
                <span style={{ opacity: 0.85, fontSize: 11 }}>{condSym}</span>
                <span className="gold" style={{ fontSize: 11 }}>
                  {condOp}
                </span>
                <span style={{ opacity: 0.85, fontSize: 11 }}>{condVal}</span>
              </>
            ) : (
              <span style={{ opacity: 0.85, fontSize: 11 }}>
                {spec.summary(draft, condSym)}
              </span>
            )}
            {trigger === "price" && (
              <>
                <span className="dim" style={{ fontSize: 10 }}>
                  via
                </span>
                <span style={{ opacity: 0.65, fontSize: 10 }}>
                  {triggerDef?.title}
                </span>
              </>
            )}
          </div>

          {/* Step 3 — Notify on */}
          <StepLabel n={3} label="Notify on" />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 8,
              marginBottom: 22,
            }}
          >
            {CHANNELS.map((c) => {
              const active = !c.soon && channels.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => !c.soon && toggleChannel(c.id)}
                  disabled={c.soon}
                  style={{
                    background: active ? "var(--ink)" : "var(--paper)",
                    color: active
                      ? "var(--paper)"
                      : c.soon
                        ? "var(--ink-4)"
                        : "var(--ink)",
                    border: "1.75px solid var(--ink)",
                    borderRadius: 10,
                    padding: "10px 4px",
                    cursor: c.soon ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                    boxShadow: active ? `3px 3px 0 ${c.pop}` : "none",
                    transform: active ? "translate(-1px,-1px)" : "none",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 5,
                    position: "relative",
                    opacity: c.soon ? 0.65 : 1,
                    transition: "box-shadow 0.1s, transform 0.1s",
                  }}
                >
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: active ? "var(--emerald)" : c.pop,
                      border:
                        "1.25px solid " +
                        (active ? "var(--paper)" : "var(--ink)"),
                      display: "grid",
                      placeItems: "center",
                      transform: "rotate(-3deg)",
                    }}
                  >
                    <c.Icon size={12} strokeWidth={2.25} />
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.3,
                    }}
                  >
                    {c.label}
                  </span>
                  {c.soon && (
                    <span
                      className="mono"
                      style={{
                        position: "absolute",
                        top: -7,
                        right: -5,
                        background: "var(--pop-2)",
                        color: "#1d1d1b",
                        border: "1.5px solid var(--ink)",
                        borderRadius: 999,
                        fontSize: 8,
                        fontWeight: 800,
                        padding: "2px 5px",
                        letterSpacing: 0.5,
                        transform: "rotate(8deg)",
                      }}
                    >
                      SOON
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Step 4 — Cooldown */}
          <StepLabel n={4} label="Cooldown" />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 8,
            }}
          >
            {COOLDOWN_OPTIONS.map((c) => {
              const active = cooldown === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setCooldown(c.id)}
                  style={{
                    padding: "10px 8px",
                    background: active ? "var(--emerald)" : "var(--paper)",
                    color: active ? "var(--paper)" : "var(--ink)",
                    border: "1.75px solid var(--ink)",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    boxShadow: active ? "2.5px 2.5px 0 var(--ink)" : "none",
                    transform: active ? "translate(-1px,-1px)" : "none",
                    transition: "box-shadow 0.1s, transform 0.1s",
                  }}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────── */}
        <div className={styles.footer}>
          <button onClick={onClose} className="pf-bf" style={{ flex: 1 }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="pf-bs"
            style={{
              flex: 2,
              background: saving ? "var(--ink-3)" : "var(--emerald)",
              borderColor: "var(--ink)",
              justifyContent: "center",
              gap: 6,
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? (
              <Loader2 size={13} strokeWidth={2.25} className="animate-spin" />
            ) : (
              <Bell size={13} strokeWidth={2.25} />
            )}
            Create alert
          </button>
        </div>
      </div>
    </>
  );
}

// ── Step label ─────────────────────────────────────────────────

function StepLabel({
  n,
  label,
  optional,
}: {
  n: number;
  label: string;
  optional?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 12,
      }}
    >
      <div
        className="mono"
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "var(--ink)",
          color: "var(--paper)",
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          fontWeight: 800,
          transform: "rotate(-3deg)",
          flexShrink: 0,
        }}
      >
        {n}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--ink)",
          letterSpacing: 1.3,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      {optional && (
        <span className="ser" style={{ fontSize: 12, color: "var(--ink-3)" }}>
          · optional
        </span>
      )}
      <div style={{ flex: 1, height: 1.5, background: "var(--rule-soft)" }} />
    </div>
  );
}

// ── Data-engine condition panel (MONEY-1204) ────────────────────

/**
 * One panel for all six data-engine triggers, rendered from the `FieldSpec[]`
 * its trigger declares. Nothing here knows which trigger it is drawing — the
 * knowledge lives in TRIGGER_SPECS beside the builder that reads the same keys.
 */
function DataEngineConditionPanel({
  fields,
  values,
  needsSymbol,
  symbolOpts,
  onSymbolOptsChange,
  fetchSymbols,
  onPatch,
  onToggleFlagKind,
}: {
  fields: readonly FieldSpec[];
  values: DataEngineDraft;
  needsSymbol: boolean;
  symbolOpts: SymbolOption[];
  onSymbolOptsChange: (v: SymbolOption[]) => void;
  fetchSymbols: (q: string) => Promise<SymbolOption[]>;
  onPatch: (p: Partial<DataEngineDraft>) => void;
  onToggleFlagKind: (id: string) => void;
}) {
  // A computed key over a union of literals widens to an index signature, so
  // the assertion is the narrowing TS cannot do — never `any`.
  const setField = (key: NumberFieldKey | ChoiceFieldKey, value: string) =>
    onPatch({ [key]: value } as Partial<DataEngineDraft>);

  return (
    <div style={{ display: "grid", gap: 10, marginBottom: 10 }}>
      {needsSymbol && (
        <PfSymbolPicker
          mode="single"
          value={symbolOpts}
          onChange={onSymbolOptsChange}
          fetchSymbols={fetchSymbols}
          placeholder="Search a symbol"
        />
      )}

      {fields.map((f) => (
        <div key={f.key} style={{ display: "grid", gap: 6 }}>
          <span
            className="mono"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}
          >
            {f.label}
          </span>

          {f.control === "number" ? (
            <div style={{ position: "relative" }}>
              <input
                value={values[f.key]}
                onChange={(e) => setField(f.key, e.target.value)}
                inputMode="decimal"
                className="pf-input mono"
                style={{
                  fontSize: 12.5,
                  paddingRight: f.suffix ? 96 : undefined,
                }}
                aria-label={f.label}
              />
              {f.suffix && (
                <span
                  className="mono"
                  style={{
                    position: "absolute",
                    right: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    fontSize: 11,
                    color: "var(--ink-3)",
                    pointerEvents: "none",
                  }}
                >
                  {f.suffix}
                </span>
              )}
            </div>
          ) : f.control === "multi" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {f.options.map((o) => (
                <ConditionChip
                  key={o.id}
                  label={o.label}
                  on={values.flagKinds.includes(o.id)}
                  onClick={() => onToggleFlagKind(o.id)}
                />
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {f.options.map((o) => (
                <ConditionChip
                  key={o.id}
                  label={o.label}
                  on={values[f.key] === o.id}
                  onClick={() => setField(f.key, o.id)}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The playful toggle chip Step 2 already uses for corporate actions. */
function ConditionChip({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className="mono"
      style={{
        padding: "9px 12px",
        background: on ? "var(--ink)" : "var(--paper)",
        color: on ? "var(--paper)" : "var(--ink)",
        border: "1.5px solid var(--ink)",
        borderRadius: 8,
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: "inherit",
        boxShadow: on ? "2.5px 2.5px 0 var(--emerald)" : "none",
        transform: on ? "translate(-1px,-1px)" : "none",
        transition: "box-shadow 0.1s, transform 0.1s",
      }}
    >
      {label}
    </button>
  );
}

// ── Custom rule builder ─────────────────────────────────────────

function CustomRuleBuilder({
  symbolOpts,
  onSymbolOptsChange,
  fetchSymbols,
  conditions,
  onChange,
  combinator,
  onCombinatorChange,
}: {
  symbolOpts: SymbolOption[];
  onSymbolOptsChange: (v: SymbolOption[]) => void;
  fetchSymbols: (q: string) => Promise<SymbolOption[]>;
  conditions: CustomCondition[];
  onChange: (c: CustomCondition[]) => void;
  combinator: "AND" | "OR";
  onCombinatorChange: (c: "AND" | "OR") => void;
}) {
  const updateRow = (i: number, patch: Partial<CustomCondition>) => {
    const next = conditions.map((c, idx) =>
      idx === i ? { ...c, ...patch } : c
    );
    onChange(next);
  };
  const removeRow = (i: number) =>
    onChange(conditions.filter((_, idx) => idx !== i));
  const addRow = () =>
    onChange([
      ...conditions,
      { field: "rsi", op: "<", value: "30" } as CustomCondition,
    ]);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ marginBottom: 8 }}>
        <PfSymbolPicker
          mode="single"
          value={symbolOpts}
          onChange={onSymbolOptsChange}
          fetchSymbols={fetchSymbols}
          placeholder="Apply on (leave blank for any symbol)"
        />
      </div>

      {/* Combinator segmented control */}
      <div
        style={{
          display: "inline-flex",
          background: "var(--paper-2)",
          border: "1.5px solid var(--ink)",
          borderRadius: 9,
          padding: 3,
          marginBottom: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            alignSelf: "center",
            paddingLeft: 6,
            paddingRight: 4,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          When
        </span>
        {(["AND", "OR"] as const).map((c) => (
          <button
            key={c}
            onClick={() => onCombinatorChange(c)}
            style={{
              padding: "5px 10px",
              background: combinator === c ? "var(--ink)" : "transparent",
              color: combinator === c ? "var(--paper)" : "var(--ink-2)",
              fontSize: 11,
              fontWeight: 700,
              border: 0,
              borderRadius: 6,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {c === "AND" ? "ALL match" : "ANY match"}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {conditions.map((c, i) => {
          const fieldDef = CUSTOM_FIELDS.find((f) => f.id === c.field);
          const opChoices = CUSTOM_OPS[fieldDef?.kind ?? "number"];
          return (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 70px 1fr 30px",
                gap: 6,
                alignItems: "center",
              }}
            >
              <select
                value={c.field}
                onChange={(e) =>
                  updateRow(i, {
                    field: e.target.value as CustomField,
                    op: CUSTOM_OPS[
                      CUSTOM_FIELDS.find(
                        (f) => f.id === (e.target.value as CustomField)
                      )?.kind ?? "number"
                    ][0],
                  })
                }
                className="pf-input mono"
                style={{ fontSize: 11.5 }}
              >
                {CUSTOM_FIELDS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select
                value={c.op}
                onChange={(e) => updateRow(i, { op: e.target.value })}
                className="pf-input mono"
                style={{
                  fontSize: 11.5,
                  textAlign: "center",
                  padding: "10px 6px",
                }}
              >
                {opChoices.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <input
                value={c.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
                placeholder="value"
                className="pf-input mono"
                style={{ fontSize: 11.5 }}
              />
              <button
                onClick={() => removeRow(i)}
                disabled={conditions.length === 1}
                style={{
                  width: 30,
                  height: 38,
                  borderRadius: 7,
                  background: "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  color: "var(--ink-3)",
                  display: "grid",
                  placeItems: "center",
                  cursor: "pointer",
                  opacity: conditions.length === 1 ? 0.4 : 1,
                }}
                aria-label="Remove condition"
              >
                <Trash2 size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        onClick={addRow}
        style={{
          marginTop: 8,
          width: "100%",
          padding: "8px 12px",
          borderRadius: 8,
          border: "1.5px dashed var(--rule-soft)",
          background: "transparent",
          color: "var(--emerald-text)",
          fontSize: 12,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <Plus size={12} strokeWidth={2.25} />
        Add condition
      </button>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────

function prettyAction(id: string): string {
  return id.charAt(0) + id.slice(1).toLowerCase();
}

function fieldLabel(id: CustomField): string {
  return CUSTOM_FIELDS.find((f) => f.id === id)?.label ?? id;
}
