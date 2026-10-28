"use client";

/**
 * Strategy Build Custom — /strategies/build
 *
 * Playful re-skin of the visual rule builder. The user composes a
 * strategy by:
 *   - Naming it
 *   - Picking a universe
 *   - Building a nested AND/OR condition tree (max depth 2)
 *   - Setting entry / exit / rebalance rules
 *   - Saving (drafts) or saving + backtest
 *
 * For this first cut we persist the draft to localStorage; the
 * server-side "saved strategies" table arrives with the backtest
 * worker integration in #83.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import {
  ArrowLeft,
  Plus,
  X,
  Trash2,
  GitBranch,
  Save,
  Play,
  Info,
  GripVertical,
  Filter,
  Eye,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

interface FieldDef {
  id: string;
  label: string;
  unit: string;
}

const FIELDS: FieldDef[] = [
  { id: "marketCap", label: "Market Cap", unit: "₹ Cr" },
  { id: "pe", label: "P/E ratio", unit: "" },
  { id: "pb", label: "P/B ratio", unit: "" },
  { id: "roe", label: "Return on Equity", unit: "%" },
  { id: "roic", label: "ROIC", unit: "%" },
  { id: "fcfMargin", label: "FCF Margin", unit: "%" },
  { id: "debtEq", label: "Debt / Equity", unit: "" },
  { id: "revGrowth", label: "Revenue Growth 3Y", unit: "%" },
  { id: "divYield", label: "Dividend Yield", unit: "%" },
  { id: "beta", label: "Beta", unit: "" },
  { id: "rsi14", label: "RSI 14", unit: "" },
  { id: "dma50", label: "Close vs 50-DMA", unit: "%" },
  { id: "dma200", label: "Close vs 200-DMA", unit: "%" },
  { id: "earningsYield", label: "Earnings Yield", unit: "%" },
];

const OPS = [">", "<", ">=", "<=", "=", "between"] as const;

const UNIVERSES = [
  { id: "nifty50", label: "NIFTY 50", count: 50 },
  { id: "nifty500", label: "NIFTY 500", count: 497 },
  { id: "bse500", label: "BSE 500", count: 499 },
  { id: "bse100", label: "BSE 100", count: 100 },
  { id: "midcap", label: "NIFTY Midcap 150", count: 148 },
  { id: "smallcap", label: "NIFTY Smallcap 250", count: 247 },
];

const REBAL = [
  { id: "monthly", label: "Monthly" },
  { id: "quarterly", label: "Quarterly" },
  { id: "annual", label: "Annual" },
  { id: "signal", label: "On signal" },
] as const;

type GroupOp = "AND" | "OR";

interface ConditionLeaf {
  id: string;
  field: string;
  op: string;
  value: string;
}

interface ConditionGroup {
  id: string;
  op: GroupOp;
  items: Array<ConditionLeaf | ConditionGroup>;
}

function isGroup(
  item: ConditionLeaf | ConditionGroup
): item is ConditionGroup {
  return (item as ConditionGroup).items !== undefined;
}

const uid = () => Math.random().toString(36).slice(2, 9);

const STORAGE_KEY = "stockbook:custom-strategy-draft";

// Bare unstyled <select>/<input> wrapped to read in the playful idiom.
const fieldInputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 7,
  background: "var(--paper)",
  border: "1.5px solid var(--ink)",
  color: "var(--ink)",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 11.5,
};

function ConditionRow({
  cond,
  onChange,
  onRemove,
  canRemove,
}: {
  cond: ConditionLeaf;
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const field = FIELDS.find((f) => f.id === cond.field) ?? FIELDS[0];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: 8,
        borderRadius: 8,
        background: "var(--rule-softer)",
        border: "1.5px solid var(--rule-soft)",
        flexWrap: "wrap",
      }}
    >
      <GripVertical
        className="h-3.5 w-3.5"
        style={{ color: "var(--ink-3)", cursor: "grab", flexShrink: 0 }}
      />
      <select
        value={cond.field}
        onChange={(e) => onChange({ ...cond, field: e.target.value })}
        style={{ ...fieldInputStyle, flex: 1, minWidth: 110 }}
      >
        {FIELDS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value })}
        style={{ ...fieldInputStyle, width: 64, fontWeight: 700 }}
      >
        {OPS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <input
        value={cond.value}
        onChange={(e) => onChange({ ...cond, value: e.target.value })}
        placeholder="value"
        style={{
          ...fieldInputStyle,
          flex: 1,
          minWidth: 70,
          color: "var(--emerald-text)",
          fontWeight: 700,
        }}
      />
      <span
        className="mono"
        style={{
          minWidth: 28,
          fontSize: 10,
          letterSpacing: 0.5,
          color: "var(--ink-3)",
        }}
      >
        {field.unit}
      </span>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          background: "transparent",
          border: "1.5px solid var(--rule-soft)",
          color: canRemove ? "#b91c1c" : "var(--ink-4)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          cursor: canRemove ? "pointer" : "not-allowed",
          opacity: canRemove ? 1 : 0.4,
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function RuleGroup({
  group,
  onChange,
  onRemoveGroup,
  depth = 0,
}: {
  group: ConditionGroup;
  onChange: (next: ConditionGroup) => void;
  onRemoveGroup?: () => void;
  depth?: number;
}) {
  const setOp = (op: GroupOp) => onChange({ ...group, op });

  const updateItem = (idx: number, item: ConditionLeaf | ConditionGroup) => {
    const items = [...group.items];
    items[idx] = item;
    onChange({ ...group, items });
  };

  const removeItem = (idx: number) =>
    onChange({
      ...group,
      items: group.items.filter((_, i) => i !== idx),
    });

  const addCond = () =>
    onChange({
      ...group,
      items: [
        ...group.items,
        { id: uid(), field: "roe", op: ">", value: "18" },
      ],
    });

  const addGroup = () =>
    onChange({
      ...group,
      items: [
        ...group.items,
        {
          id: uid(),
          op: "AND",
          items: [{ id: uid(), field: "pe", op: "<", value: "20" }],
        },
      ],
    });

  const accent = depth === 0 ? "var(--emerald)" : "var(--pop-5)";

  return (
    <div
      style={{
        padding: 12,
        border: `1.5px dashed ${accent}`,
        borderRadius: 10,
        background:
          depth === 0 ? "var(--emerald-bg)" : "rgba(167,139,250,0.06)",
        marginLeft: depth * 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 3,
            padding: 2,
            borderRadius: 7,
            border: "1.5px solid var(--ink)",
            background: "var(--paper)",
          }}
        >
          {(["AND", "OR"] as const).map((o) => {
            const on = group.op === o;
            return (
              <button
                key={o}
                type="button"
                onClick={() => setOp(o)}
                className="mono"
                style={{
                  padding: "4px 10px",
                  borderRadius: 5,
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  border: 0,
                  cursor: "pointer",
                  background: on ? "var(--ink)" : "transparent",
                  color: on ? "var(--paper)" : "var(--ink-3)",
                }}
              >
                {o}
              </button>
            );
          })}
        </div>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            letterSpacing: 1,
            color: "var(--ink-3)",
            fontWeight: 700,
          }}
        >
          · {group.items.length} CONDITION
          {group.items.length !== 1 ? "S" : ""}
        </span>
        <div style={{ flex: 1 }} />
        {depth > 0 && onRemoveGroup && (
          <button
            type="button"
            onClick={onRemoveGroup}
            title="Remove group"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: "transparent",
              border: "1.5px solid var(--rule-soft)",
              color: "#b91c1c",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Trash2 className="h-2.5 w-2.5" />
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {group.items.map((it, i) =>
          isGroup(it) ? (
            <RuleGroup
              key={it.id}
              group={it}
              onChange={(g) => updateItem(i, g)}
              onRemoveGroup={() => removeItem(i)}
              depth={depth + 1}
            />
          ) : (
            <ConditionRow
              key={it.id}
              cond={it}
              onChange={(c) => updateItem(i, c)}
              onRemove={() => removeItem(i)}
              canRemove={group.items.length > 1 || depth > 0}
            />
          )
        )}
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={addCond}
          className="pf-pill outline"
          style={{ cursor: "pointer", borderStyle: "dashed" }}
        >
          <Plus className="h-2.5 w-2.5" /> Add condition
        </button>
        {depth < 2 && (
          <button
            type="button"
            onClick={addGroup}
            className="pf-pill outline"
            style={{
              cursor: "pointer",
              borderStyle: "dashed",
              color: "var(--pop-5-text)",
              borderColor: "var(--pop-5)",
            }}
          >
            <GitBranch className="h-2.5 w-2.5" /> Add group
          </button>
        )}
      </div>
    </div>
  );
}

function countConditions(group: ConditionGroup): number {
  let n = 0;
  for (const item of group.items) {
    if (isGroup(item)) n += countConditions(item);
    else n += 1;
  }
  return n;
}

export default function StrategyBuildCustomClient(
  props: { embedded?: boolean } = {}
) {
  return props.embedded ? (
    <BuildCustomBody />
  ) : (
    <PageGuard
      route="/strategies"
      containerClassName="p-6 pb-24 max-w-[1280px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page" style={{ paddingTop: 16 }}>
              <Link
                href="/strategies"
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--ink-3)",
                  marginBottom: 14,
                }}
              >
                <ArrowLeft className="h-3 w-3" /> All strategies
              </Link>
              <BuildCustomBody />
            </div>
        </main>
      </div>
    </PageGuard>
  );
}

export function BuildCustomBody() {
  const [name, setName] = useState("My quality + momentum");
  const [universe, setUniverse] = useState("nifty500");
  const [rebal, setRebal] = useState("monthly");
  const [entry, setEntry] = useState(
    "First trading day of month, equal weight"
  );
  const [exitRule, setExitRule] = useState("On screen dropout at rebalance");
  const [maxPositions, setMaxPositions] = useState("30");
  const [sizing, setSizing] = useState("equal");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");

  const [conditions, setConditions] = useState<ConditionGroup>(() => ({
    id: uid(),
    op: "AND",
    items: [
      { id: uid(), field: "marketCap", op: ">", value: "5000" },
      { id: uid(), field: "roe", op: ">", value: "18" },
      { id: uid(), field: "debtEq", op: "<", value: "0.5" },
    ],
  }));

  // Hydrate draft if present
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      if (draft.name) setName(draft.name);
      if (draft.universe) setUniverse(draft.universe);
      if (draft.rebal) setRebal(draft.rebal);
      if (draft.entry) setEntry(draft.entry);
      if (draft.exitRule) setExitRule(draft.exitRule);
      if (draft.maxPositions) setMaxPositions(draft.maxPositions);
      if (draft.sizing) setSizing(draft.sizing);
      if (draft.stopLoss !== undefined) setStopLoss(draft.stopLoss);
      if (draft.takeProfit !== undefined) setTakeProfit(draft.takeProfit);
      if (draft.conditions) setConditions(draft.conditions);
    } catch {
      // ignore — bad draft
    }
  }, []);

  const saveDraft = () => {
    const draft = {
      name,
      universe,
      rebal,
      entry,
      exitRule,
      maxPositions,
      sizing,
      stopLoss,
      takeProfit,
      conditions,
    };
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    }
    toast.success(`Draft saved · "${name}"`);
  };

  const resetDraft = () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
    setName("My quality + momentum");
    setUniverse("nifty500");
    setRebal("monthly");
    setEntry("First trading day of month, equal weight");
    setExitRule("On screen dropout at rebalance");
    setMaxPositions("30");
    setSizing("equal");
    setStopLoss("");
    setTakeProfit("");
    setConditions({
      id: uid(),
      op: "AND",
      items: [
        { id: uid(), field: "marketCap", op: ">", value: "5000" },
        { id: uid(), field: "roe", op: ">", value: "18" },
        { id: uid(), field: "debtEq", op: "<", value: "0.5" },
      ],
    });
    toast.info("Draft reset to defaults");
  };

  const totalConditions = countConditions(conditions);
  const universeDef = UNIVERSES.find((u) => u.id === universe);
  const universeSize = universeDef?.count ?? 500;
  // Synthetic match-count — design uses 0.55^condCount; floor at 8.
  const previewMatches = Math.max(
    8,
    Math.round(universeSize * Math.pow(0.55, totalConditions))
  );
  const passPct = (previewMatches / universeSize) * 100;
  const filledBars = Math.round((previewMatches / universeSize) * 20);

  const validationErrors = useMemo(() => {
    const errs: string[] = [];
    if (!name.trim()) errs.push("Strategy needs a name");
    if (totalConditions === 0) errs.push("Add at least one condition");
    return errs;
  }, [name, totalConditions]);

  return (
    <div>
      {/* Identity row — editable name + CUSTOM·BUILDER + Educational pill */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="pf-input"
          style={{
            flex: 1,
            minWidth: 240,
            fontSize: 22,
            fontWeight: 800,
            letterSpacing: -0.4,
          }}
        />
        <span className="pf-pill violet">CUSTOM · BUILDER</span>
        <span className="pf-pill gold" style={{ textTransform: "uppercase" }}>
          Educational · Not advice
        </span>
      </div>

      {/* Live preview banner */}
      <div
        className="pf-card tilt-r"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "16px 18px",
          background: "var(--emerald-bg)",
          borderColor: "var(--emerald)",
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <span
          className="pf-av-sq"
          style={{
            width: 38,
            height: 38,
            background: "var(--emerald)",
            color: "#fff",
          }}
        >
          <Filter className="h-4 w-4" />
        </span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              letterSpacing: 1.4,
              color: "var(--emerald-text)",
              fontWeight: 700,
            }}
          >
            LIVE PREVIEW · UNIVERSE MATCH
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginTop: 4,
              flexWrap: "wrap",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 28,
                fontWeight: 800,
                color: "var(--emerald-text)",
                letterSpacing: -0.6,
              }}
            >
              {previewMatches}
            </span>
            <span
              className="mono"
              style={{ fontSize: 12, color: "var(--ink-3)" }}
            >
              of {universeSize} · {totalConditions} condition
              {totalConditions !== 1 ? "s" : ""} · ~{passPct.toFixed(1)}% pass
            </span>
          </div>
        </div>
        <div
          style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 28 }}
        >
          {Array.from({ length: 20 }).map((_, i) => {
            const baseHeight = 18 + Math.sin(i * 0.7) * 4;
            const filled = i < filledBars;
            return (
              <span
                key={i}
                style={{
                  width: 4,
                  borderRadius: 2,
                  height: baseHeight,
                  background: filled ? "var(--emerald)" : "var(--rule-soft)",
                }}
              />
            );
          })}
        </div>
        <button
          type="button"
          onClick={() =>
            toast.info("Preview matches launches with backtest worker.")
          }
          className="pf-bf sm"
          style={{ borderColor: "var(--emerald)", color: "var(--emerald-text)" }}
        >
          <Eye className="h-3 w-3" /> Preview matches
        </button>
      </div>

      {/* Main grid — conditions builder (1.5fr) + right column (1fr) */}
      <div
        className="strat-build-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        {/* CONDITIONS BUILDER */}
        <div className="pf-card" style={{ padding: 18 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <Filter
              className="h-3.5 w-3.5"
              style={{ color: "var(--emerald-text)" }}
            />
            <div className="ttl">CONDITIONS</div>
            <span
              className="mono"
              style={{ fontSize: 9.5, color: "var(--ink-3)" }}
            >
              · drag rows to reorder
            </span>
          </div>
          <RuleGroup group={conditions} onChange={setConditions} />
        </div>

        {/* RIGHT COLUMN — universe / entry / exit / sizing-rebal */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* UNIVERSE — 2-col card grid */}
          <RuleCard label="UNIVERSE" color="var(--pop-5-text)">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 6,
              }}
            >
              {UNIVERSES.map((u) => {
                const on = universe === u.id;
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setUniverse(u.id)}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: `1.5px solid ${on ? "var(--pop-5)" : "var(--rule-soft)"}`,
                      background: on
                        ? "rgba(167,139,250,0.1)"
                        : "var(--rule-softer)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: on ? "var(--pop-5-text)" : "var(--ink)",
                      }}
                    >
                      {u.label}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 9.5, color: "var(--ink-3)" }}
                    >
                      {u.count} stocks
                    </span>
                  </button>
                );
              })}
            </div>
          </RuleCard>

          {/* ENTRY */}
          <RuleCard label="ENTRY" color="var(--emerald-text)">
            <textarea
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              rows={2}
              className="pf-input mono"
              style={{ fontSize: 11.5, lineHeight: 1.5, resize: "vertical" }}
            />
          </RuleCard>

          {/* EXIT + STOP/TAKE */}
          <RuleCard label="EXIT" color="#b91c1c">
            <textarea
              value={exitRule}
              onChange={(e) => setExitRule(e.target.value)}
              rows={2}
              className="pf-input mono"
              style={{ fontSize: 11.5, lineHeight: 1.5, resize: "vertical" }}
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 6,
                marginTop: 8,
              }}
            >
              <div>
                <SmallLabel>STOP-LOSS %</SmallLabel>
                <input
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder="none"
                  className="pf-input mono"
                  style={{ marginTop: 4, fontSize: 11.5 }}
                />
              </div>
              <div>
                <SmallLabel>TAKE-PROFIT %</SmallLabel>
                <input
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  placeholder="none"
                  className="pf-input mono"
                  style={{ marginTop: 4, fontSize: 11.5 }}
                />
              </div>
            </div>
          </RuleCard>

          {/* POSITION SIZING & REBALANCE */}
          <RuleCard label="POSITION SIZING & REBALANCE" color="var(--pop-2-text)">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 6,
                marginBottom: 8,
              }}
            >
              <div>
                <SmallLabel>MAX POSITIONS</SmallLabel>
                <input
                  value={maxPositions}
                  onChange={(e) => setMaxPositions(e.target.value)}
                  className="pf-input mono"
                  style={{ marginTop: 4, fontSize: 11.5 }}
                />
              </div>
              <div>
                <SmallLabel>SIZING</SmallLabel>
                <select
                  value={sizing}
                  onChange={(e) => setSizing(e.target.value)}
                  className="pf-input mono"
                  style={{ marginTop: 4, fontSize: 11.5 }}
                >
                  <option value="equal">Equal weight</option>
                  <option value="capwt">Market-cap weighted</option>
                  <option value="voltgt">Vol-target (1% per name)</option>
                  <option value="rank">Rank-weighted</option>
                </select>
              </div>
            </div>
            <SmallLabel>REBALANCE</SmallLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 4,
                marginTop: 4,
              }}
            >
              {REBAL.map((r) => {
                const on = rebal === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRebal(r.id)}
                    className="mono"
                    style={{
                      padding: "6px 4px",
                      borderRadius: 6,
                      fontSize: 10.5,
                      fontWeight: 700,
                      border: `1.5px solid ${on ? "var(--pop-2)" : "var(--rule-soft)"}`,
                      cursor: "pointer",
                      background: on
                        ? "rgba(251,191,36,0.12)"
                        : "var(--rule-softer)",
                      color: on ? "var(--pop-2-text)" : "var(--ink-3)",
                    }}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </RuleCard>
        </div>
      </div>

      {/* Auto-generated DSL preview (pf-codeblock) */}
      <div className="pf-card" style={{ padding: 18, marginBottom: 14 }}>
        <div className="ttl" style={{ marginBottom: 10 }}>
          AUTO-GENERATED DSL
        </div>
        <div className="pf-codeblock">
          <span className="em">universe</span> · {universeDef?.label} ·{" "}
          {universeDef?.count} stocks
          <br />
          <span className="em">entry</span> · {entry}
          <br />
          <span className="gold">exit</span> · {exitRule}
          <br />
          <span className="dim">size</span> · {sizing} · max {maxPositions}{" "}
          positions
          <br />
          <span className="dim">rebalance</span> ·{" "}
          {REBAL.find((r) => r.id === rebal)?.label ?? rebal}
          {stopLoss ? (
            <>
              <br />
              <span className="dim">stop-loss</span> · {stopLoss}%
            </>
          ) : null}
          {takeProfit ? (
            <>
              <br />
              <span className="dim">take-profit</span> · {takeProfit}%
            </>
          ) : null}
          <br />
          <span className="dim">
            {`// ${totalConditions} condition${
              totalConditions !== 1 ? "s" : ""
            } · ~${previewMatches} of ${universeSize} match`}
          </span>
        </div>
      </div>

      {/* Validation hint */}
      {validationErrors.length > 0 && (
        <div
          className="pf-card"
          style={{
            padding: 12,
            marginBottom: 14,
            background: "var(--pop-2)",
            borderColor: "var(--ink)",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <Info
            className="h-3 w-3"
            style={{ color: "#1d1d1b", flexShrink: 0, marginTop: 2 }}
          />
          <ul
            className="mono"
            style={{
              flex: 1,
              listStyle: "none",
              padding: 0,
              margin: 0,
              fontSize: 10.5,
              color: "#1d1d1b",
              lineHeight: 1.6,
            }}
          >
            {validationErrors.map((e) => (
              <li key={e}>· {e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Action footer */}
      <div
        className="pf-card"
        style={{
          padding: 16,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <button type="button" onClick={resetDraft} className="pf-bf">
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
        <button
          type="button"
          onClick={saveDraft}
          disabled={validationErrors.length > 0}
          className="pf-bf"
          style={
            validationErrors.length > 0
              ? { opacity: 0.55, cursor: "not-allowed" }
              : undefined
          }
        >
          <Save className="h-3 w-3" /> Save draft
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() =>
            toast.info("Preview matches launches with backtest worker.")
          }
          className="pf-bf"
        >
          <Eye className="h-3 w-3" /> Preview universe
        </button>
        <button
          type="button"
          onClick={() => {
            saveDraft();
            toast.info(
              "Save & Backtest queued — connect a draft strategy ID once persistence ships."
            );
          }}
          disabled={validationErrors.length > 0}
          className="pf-bs"
          style={
            validationErrors.length > 0
              ? { opacity: 0.55, cursor: "not-allowed" }
              : undefined
          }
        >
          <Play className="h-3 w-3" /> Save & backtest
        </button>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .strat-build-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function SmallLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9,
        letterSpacing: 1,
        color: "var(--ink-3)",
        fontWeight: 700,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function RuleCard({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pf-card" style={{ padding: 14 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.4,
          fontWeight: 700,
          marginBottom: 10,
          color,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
