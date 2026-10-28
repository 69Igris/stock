"use client";

/**
 * New Feed Drawer — playful right-side sheet on desktop, bottom sheet on mobile.
 * 4 steps: name · what to include (sector/symbol) · keywords · frequency.
 *
 * Design: §04 from pf-creators.jsx (playful design bundle).
 * Wiring preserved: feed-storage.ts persistence, FeedDef shape, prefilledSymbols/Name, toast.
 * Symbol selector: PfSymbolPicker (multi mode) wired to /api/market/autocomplete.
 */

import { useCallback, useEffect, useState } from "react";
import {
  X,
  Rss,
  Loader2,
  type LucideIcon,
  Briefcase,
  Building2,
  Landmark,
  Cpu,
  Pill,
  Car,
  Cookie,
  Zap,
  ShoppingBag,
  Heart,
  Radio,
  Building,
  Hammer,
  Tv,
  HardHat,
  FlaskConical,
  Plug,
  Shield,
  Wrench,
  Wheat,
  Shirt,
  Check,
  Filter,
} from "lucide-react";
import { toast } from "sonner";
import type { FeedDef } from "./feed-storage";
import {
  PfSymbolPicker,
  type SymbolOption,
} from "@/components/playful/PfSymbolPicker";
import styles from "./alert-drawer.module.css";

const SECTOR_POPS = [
  "var(--pop-3)",
  "var(--pop-2)",
  "var(--pop-5)",
  "var(--pop-4)",
  "var(--emerald)",
  "var(--pop-1)",
  "var(--pop-3)",
  "var(--pop-4)",
  "var(--pop-5)",
  "var(--pop-2)",
  "var(--pop-1)",
  "var(--pop-3)",
  "var(--pop-4)",
  "var(--pop-5)",
  "var(--pop-1)",
  "var(--emerald)",
  "var(--pop-2)",
  "var(--pop-3)",
  "var(--pop-4)",
  "var(--pop-5)",
  "var(--pop-1)",
];

const PRESET_SECTORS: Array<{
  id: string;
  label: string;
  Icon: LucideIcon;
  symbols: string[];
  pop: string;
}> = [
  {
    id: "it",
    label: "Information Technology",
    Icon: Cpu,
    symbols: ["TCS", "INFY", "WIPRO", "HCLTECH", "TECHM", "LTIM"],
    pop: SECTOR_POPS[0],
  },
  {
    id: "private_banks",
    label: "Private banks",
    Icon: Landmark,
    symbols: ["HDFCBANK", "ICICIBANK", "AXISBANK", "KOTAKBANK", "INDUSINDBK"],
    pop: SECTOR_POPS[1],
  },
  {
    id: "psu_banks",
    label: "PSU banks",
    Icon: Building2,
    symbols: ["SBIN", "BANKBARODA", "PNB", "CANBK", "UNIONBANK"],
    pop: SECTOR_POPS[2],
  },
  {
    id: "nbfc",
    label: "NBFCs & Financials",
    Icon: Briefcase,
    symbols: [
      "BAJFINANCE",
      "BAJAJFINSV",
      "CHOLAFIN",
      "MUTHOOTFIN",
      "SHRIRAMFIN",
      "M&MFIN",
    ],
    pop: SECTOR_POPS[3],
  },
  {
    id: "insurance",
    label: "Insurance",
    Icon: Shield,
    symbols: ["SBILIFE", "HDFCLIFE", "ICICIPRULI", "ICICIGI", "NIVABUPA"],
    pop: SECTOR_POPS[4],
  },
  {
    id: "auto",
    label: "Automobile",
    Icon: Car,
    symbols: ["MARUTI", "TATAMOTORS", "M&M", "BAJAJ-AUTO", "EICHERMOT"],
    pop: SECTOR_POPS[5],
  },
  {
    id: "fmcg",
    label: "FMCG",
    Icon: Cookie,
    symbols: ["HINDUNILVR", "ITC", "NESTLEIND", "BRITANNIA", "DABUR"],
    pop: SECTOR_POPS[6],
  },
  {
    id: "pharma",
    label: "Pharmaceuticals",
    Icon: Pill,
    symbols: ["SUNPHARMA", "CIPLA", "DRREDDY", "DIVISLAB", "LUPIN"],
    pop: SECTOR_POPS[7],
  },
  {
    id: "healthcare",
    label: "Healthcare",
    Icon: Heart,
    symbols: ["APOLLOHOSP", "FORTIS", "MAXHEALTH", "NH", "MEDPLUS"],
    pop: SECTOR_POPS[8],
  },
  {
    id: "energy",
    label: "Energy",
    Icon: Zap,
    symbols: ["RELIANCE", "ONGC", "BPCL", "IOC", "GAIL"],
    pop: SECTOR_POPS[9],
  },
  {
    id: "utilities",
    label: "Power & Utilities",
    Icon: Plug,
    symbols: ["NTPC", "POWERGRID", "TATAPOWER", "ADANIPOWER", "JSWENERGY"],
    pop: SECTOR_POPS[10],
  },
  {
    id: "telecom",
    label: "Telecommunication",
    Icon: Radio,
    symbols: ["BHARTIARTL", "IDEA", "INDUSTOWER", "TATACOMM", "ROUTE"],
    pop: SECTOR_POPS[11],
  },
  {
    id: "metals",
    label: "Metals & Commodities",
    Icon: Hammer,
    symbols: ["TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL", "JINDALSTEL"],
    pop: SECTOR_POPS[12],
  },
  {
    id: "cement",
    label: "Cement & Construction",
    Icon: HardHat,
    symbols: ["ULTRACEMCO", "GRASIM", "AMBUJACEM", "ACC", "SHREECEM"],
    pop: SECTOR_POPS[13],
  },
  {
    id: "industrials",
    label: "Industrials & Capital goods",
    Icon: Wrench,
    symbols: ["LT", "BHEL", "SIEMENS", "ABB", "CUMMINSIND"],
    pop: SECTOR_POPS[14],
  },
  {
    id: "realestate",
    label: "Real Estate",
    Icon: Building,
    symbols: ["DLF", "GODREJPROP", "OBEROIRLTY", "PRESTIGE", "BRIGADE"],
    pop: SECTOR_POPS[15],
  },
  {
    id: "consumer_disc",
    label: "Consumer Discretionary",
    Icon: ShoppingBag,
    symbols: ["TITAN", "DMART", "TRENT", "ABFRL", "VMART"],
    pop: SECTOR_POPS[16],
  },
  {
    id: "media",
    label: "Media & Entertainment",
    Icon: Tv,
    symbols: ["ZEEL", "SUNTV", "PVRINOX", "TIPSINDLTD", "NETWORK18"],
    pop: SECTOR_POPS[17],
  },
  {
    id: "chemicals",
    label: "Chemicals",
    Icon: FlaskConical,
    symbols: ["SRF", "PIIND", "DEEPAKNTR", "NAVINFLUOR", "AARTIIND"],
    pop: SECTOR_POPS[18],
  },
  {
    id: "textiles",
    label: "Textiles",
    Icon: Shirt,
    symbols: ["PAGEIND", "ABFRL", "VARDHMAN", "TRIDENT", "ARVIND"],
    pop: SECTOR_POPS[19],
  },
  {
    id: "agriculture",
    label: "Agriculture",
    Icon: Wheat,
    symbols: ["UPL", "GODREJAGRO", "RALLIS", "BAYERCROP", "PIIND"],
    pop: SECTOR_POPS[20],
  },
];

const SENTIMENT_OPTIONS = [
  { id: "any", label: "Any" },
  { id: "positive", label: "Positive only" },
  { id: "negative", label: "Negative only" },
] as const;

type Sentiment = (typeof SENTIMENT_OPTIONS)[number]["id"];

const SENTIMENT_ACTIVE_BG: Record<string, string> = {
  any: "var(--ink)",
  positive: "var(--emerald)",
  negative: "var(--pop-1)",
};

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (feed: FeedDef) => void;
  prefilledSymbols?: string[];
  prefilledName?: string;
}

export default function NewFeedDrawer({
  open,
  onClose,
  onCreate,
  prefilledSymbols,
  prefilledName,
}: Props) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"symbols" | "sector">("sector");
  const [activeSectors, setActiveSectors] = useState<string[]>([]);
  const [chosenSymbols, setChosenSymbols] = useState<SymbolOption[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [kwInput, setKwInput] = useState("");
  const [sentiment, setSentiment] = useState<Sentiment>("any");
  const [frequency, setFrequency] = useState<
    "live" | "hourly" | "daily" | "weekly"
  >("live");
  const [saving, setSaving] = useState(false);
  const [sectorQuery, setSectorQuery] = useState("");

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

  useEffect(() => {
    if (!open) return;
    if (prefilledSymbols && prefilledSymbols.length > 0) {
      setMode("symbols");
      setChosenSymbols(
        prefilledSymbols.map((s) => ({
          sym: s.toUpperCase(),
          exch: "NSE",
          kind: "EQUITY",
        }))
      );
    }
    if (prefilledName) setName(prefilledName);
  }, [open, prefilledSymbols, prefilledName]);

  if (!open) return null;

  const symbolsFromMode = (): string[] => {
    if (mode === "sector") {
      const set = new Set<string>();
      for (const id of activeSectors) {
        const preset = PRESET_SECTORS.find((p) => p.id === id);
        preset?.symbols.forEach((s) => set.add(s));
      }
      return Array.from(set);
    }
    return chosenSymbols.map((s) => s.sym);
  };

  const toggleSector = (id: string) => {
    setActiveSectors((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    if (!name.trim()) {
      const justAdded = !activeSectors.includes(id);
      if (justAdded) {
        const preset = PRESET_SECTORS.find((p) => p.id === id);
        if (preset && activeSectors.length === 0) setName(preset.label);
      }
    }
  };

  const resetSectors = () => setActiveSectors([]);

  const removeKeyword = (kw: string) => {
    setKeywords((prev) => prev.filter((k) => k !== kw));
  };

  const handleSave = () => {
    const symbols = symbolsFromMode();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Give the feed a name");
      return;
    }
    if (symbols.length === 0 && keywords.length === 0 && !kwInput.trim()) {
      toast.error("Add at least one symbol, sector, or keyword");
      return;
    }
    setSaving(true);
    const def: FeedDef = {
      id: `feed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmedName,
      symbols,
      keywords:
        keywords.length > 0
          ? keywords
          : kwInput.trim()
            ? kwInput
                .split(/[,;]/)
                .map((k) => k.trim())
                .filter(Boolean)
            : [],
      sentiment,
      createdAt: new Date().toISOString(),
      source: "custom",
    };
    onCreate(def);
    toast.success(`Feed "${def.name}" created`);
    setName("");
    setActiveSectors([]);
    setChosenSymbols([]);
    setKeywords([]);
    setKwInput("");
    setSentiment("any");
    setFrequency("live");
    setSaving(false);
    onClose();
  };

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

      {/* Sheet */}
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
              background: "var(--pop-3)",
              border: "1.5px solid var(--ink)",
              display: "grid",
              placeItems: "center",
              transform: "rotate(-4deg)",
              boxShadow: "2.5px 2.5px 0 var(--ink)",
              flexShrink: 0,
            }}
          >
            <Rss size={17} strokeWidth={2.25} color="var(--paper)" />
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
              New feed
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
              Custom news stream
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

        {/* ── Body ────────────────────────────────────────────── */}
        <div className={styles.body}>
          {/* Step 1 — Name */}
          <StepLabel n={1} label="Name" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. IT services, PSU banks, Macro watch"
            className="pf-input"
            style={{ fontSize: 13.5, marginBottom: 22 }}
            maxLength={60}
          />

          {/* Step 2 — What to include */}
          <StepLabel n={2} label="What to include" />

          {/* Segmented mode toggle + reset */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <div
              style={{
                display: "inline-flex",
                background: "var(--paper-2)",
                border: "1.5px solid var(--ink)",
                borderRadius: 9,
                padding: 3,
              }}
            >
              {(
                [
                  ["sector", "By sector"],
                  ["symbols", "By symbols"],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setMode(k)}
                  style={{
                    padding: "6px 12px",
                    background: mode === k ? "var(--ink)" : "transparent",
                    color: mode === k ? "var(--paper)" : "var(--ink-2)",
                    fontSize: 12,
                    fontWeight: 700,
                    border: 0,
                    borderRadius: 6,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {l}
                </button>
              ))}
            </div>

            {mode === "sector" && (
              <button
                type="button"
                onClick={resetSectors}
                disabled={activeSectors.length === 0}
                className="pf-pill"
                style={{
                  background: "var(--paper)",
                  fontSize: 10,
                  padding: "3px 9px",
                  cursor:
                    activeSectors.length === 0 ? "not-allowed" : "pointer",
                  opacity: activeSectors.length === 0 ? 0.4 : 1,
                  gap: 5,
                }}
              >
                <Filter size={10} strokeWidth={2.25} />
                Reset
              </button>
            )}
          </div>

          {/* Helper hint */}
          <div
            className="ser"
            style={{
              fontSize: 12.5,
              color: "var(--ink-3)",
              marginBottom: 10,
            }}
          >
            {mode === "sector"
              ? "Pick one or more — we’ll stream in articles about them."
              : "Search and add symbols below."}
          </div>

          {mode === "sector" ? (
            <>
              <input
                value={sectorQuery}
                onChange={(e) => setSectorQuery(e.target.value)}
                placeholder="Filter sectors…"
                className="pf-input mono"
                style={{ marginBottom: 10, fontSize: 12.5 }}
              />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginBottom: 22,
                  maxHeight: 300,
                  overflowY: "auto",
                  paddingRight: 4,
                }}
              >
                {PRESET_SECTORS.filter((s) =>
                  s.label
                    .toLowerCase()
                    .includes(sectorQuery.trim().toLowerCase())
                ).map((s) => {
                  const active = activeSectors.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggleSector(s.id)}
                      style={{
                        padding: "10px 12px",
                        background: active ? "var(--ink)" : "var(--paper)",
                        color: active ? "var(--paper)" : "var(--ink)",
                        border: "1.5px solid var(--ink)",
                        borderRadius: 10,
                        fontFamily: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                        boxShadow: active
                          ? `2.5px 2.5px 0 var(--emerald)`
                          : "none",
                        transform: active ? "translate(-1px,-1px)" : "none",
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        transition: "box-shadow 0.1s, transform 0.1s",
                      }}
                    >
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          background: s.pop,
                          border:
                            "1.25px solid " +
                            (active ? "var(--paper)" : "var(--ink)"),
                          display: "grid",
                          placeItems: "center",
                          transform: "rotate(-3deg)",
                          flexShrink: 0,
                        }}
                      >
                        <s.Icon size={11} strokeWidth={2.25} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 700,
                            lineHeight: 1.15,
                          }}
                        >
                          {s.label}
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 9.5,
                            color: active ? "var(--paper)" : "var(--ink-3)",
                            letterSpacing: 0.5,
                            marginTop: 2,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {s.symbols.slice(0, 3).join(" · ")} +{" "}
                          {s.symbols.length - 3} MORE
                        </div>
                      </div>
                      {active && (
                        <Check
                          size={13}
                          strokeWidth={3}
                          color="var(--emerald-text)"
                          style={{ flexShrink: 0 }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={{ marginBottom: 22 }}>
              <PfSymbolPicker
                mode="multi"
                value={chosenSymbols}
                onChange={setChosenSymbols}
                fetchSymbols={fetchSymbols}
                placeholder="Search NSE / BSE — pick symbols to add"
              />
            </div>
          )}

          {/* Step 3 — Keywords (optional) */}
          <StepLabel n={3} label="Keywords" optional />
          {/* Keyword chips */}
          {keywords.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 8,
              }}
            >
              {keywords.map((kw) => (
                <span
                  key={kw}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 6px 3px 10px",
                    background: "var(--pop-2)",
                    color: "#1d1d1b",
                    border: "1.5px solid var(--ink)",
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 700,
                  }}
                >
                  {kw}
                  <button
                    type="button"
                    onClick={() => removeKeyword(kw)}
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      background: "rgba(0,0,0,.2)",
                      border: 0,
                      display: "grid",
                      placeItems: "center",
                      cursor: "pointer",
                      padding: 0,
                    }}
                    aria-label={`Remove keyword ${kw}`}
                  >
                    <X size={8} strokeWidth={2.5} color="#1d1d1b" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={kwInput}
            onChange={(e) => setKwInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && kwInput.trim()) {
                setKeywords((prev) => [...prev, kwInput.trim()]);
                setKwInput("");
              }
            }}
            placeholder="ARPU, layoffs, RBI policy, Q3…"
            className="pf-input"
            style={{ fontSize: 13 }}
          />
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              marginTop: 6,
              marginBottom: 22,
              letterSpacing: 0.3,
            }}
          >
            Only show articles whose title or snippet contains any of these.
          </div>

          {/* Step 4 — Frequency */}
          <StepLabel n={4} label="Frequency" />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 8,
            }}
          >
            {(
              [
                ["live", "Live", "as it happens"],
                ["hourly", "Hourly", "rolled up"],
                ["daily", "Daily 18:00", "EOD digest"],
                ["weekly", "Weekly Mon 09:00", "summary"],
              ] as const
            ).map(([k, l, sub]) => {
              const active = frequency === k;
              return (
                <button
                  key={k}
                  onClick={() => setFrequency(k)}
                  style={{
                    padding: "10px 12px",
                    background: active ? "var(--emerald)" : "var(--paper)",
                    color: active ? "var(--paper)" : "var(--ink)",
                    border: "1.5px solid var(--ink)",
                    borderRadius: 9,
                    boxShadow: active ? "2px 2px 0 var(--ink)" : "none",
                    transform: active ? "translate(-1px,-1px)" : "none",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    transition: "box-shadow 0.1s, transform 0.1s",
                  }}
                >
                  <div
                    style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.15 }}
                  >
                    {l}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      opacity: 0.8,
                      marginTop: 2,
                    }}
                  >
                    {sub}
                  </div>
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
            disabled={saving || !name.trim()}
            className="pf-bs"
            style={{
              flex: 2,
              background:
                saving || !name.trim() ? "var(--ink-3)" : "var(--emerald)",
              borderColor: "var(--ink)",
              justifyContent: "center",
              gap: 6,
              opacity: saving || !name.trim() ? 0.6 : 1,
            }}
          >
            {saving ? (
              <Loader2 size={13} strokeWidth={2.25} className="animate-spin" />
            ) : (
              <Rss size={13} strokeWidth={2.25} />
            )}
            Create feed
          </button>
        </div>
      </div>
    </>
  );
}

// ── Step label (shared with AlertDrawer) ─────────────────────────

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
