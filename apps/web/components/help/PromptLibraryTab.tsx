"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  PieChart,
  Briefcase,
  BarChart3,
  Landmark,
  Search,
  Flame,
  FileSpreadsheet,
  Compass,
  TrendingUp,
  TrendingDown,
  Layers,
  Link2,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  IndianRupee,
  Crown,
  CircleDot,
  Target,
  Clock,
  BookOpen,
  Percent,
  Repeat,
  GitCompare,
  Calculator,
  Filter,
  FileText,
  HelpCircle,
  Plus,
  Calendar,
  Banknote,
  Sunset,
  ShoppingCart,
  Wallet,
  Lightbulb,
  XCircle,
  Sparkles,
  Rocket,
  Shield,
  ArrowRight,
  Brain,
  LineChart,
  MessageSquare,
  SlidersHorizontal,
  ShieldAlert,
  Receipt,
  type LucideIcon,
} from "lucide-react";
import {
  categories,
  prompts,
  type PromptCategory,
  type PromptItem,
} from "@/app/help/lib/prompt-library";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";

const iconMap: Record<string, LucideIcon> = {
  PieChart,
  Briefcase,
  BarChart3,
  Landmark,
  Search,
  Flame,
  FileSpreadsheet,
  Compass,
  TrendingUp,
  TrendingDown,
  Layers,
  Link2,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  IndianRupee,
  Crown,
  CircleDot,
  Target,
  Clock,
  BookOpen,
  Percent,
  Repeat,
  GitCompare,
  Calculator,
  Filter,
  FileText,
  HelpCircle,
  Plus,
  Calendar,
  Banknote,
  Sunset,
  ShoppingCart,
  Wallet,
  Lightbulb,
  XCircle,
  Sparkles,
  Rocket,
  Shield,
  Brain,
  LineChart,
  MessageSquare,
  SlidersHorizontal,
  ShieldAlert,
  Receipt,
};

/* Accent colours cycling through design palette — no buy/sell/hold colours */
const ACCENT_CYCLE = [
  "var(--emerald)",
  "var(--pop-1)",
  "var(--pop-3)",
  "var(--pop-4)",
  "var(--pop-5)",
  "var(--pop-2)",
] as const;

export default function PromptLibraryTab() {
  const router = useRouter();
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const visibleCategories = paperTradingEnabled
    ? categories
    : categories.filter((c) => c.id !== "paper-trading");
  const visiblePrompts = paperTradingEnabled
    ? prompts
    : prompts.filter((p) => p.category !== "paper-trading");
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<PromptCategory | "all">(
    "all"
  );

  const filtered = useMemo(() => {
    let list = visiblePrompts;

    if (activeCategory !== "all") {
      list = list.filter((p) => p.category === activeCategory);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.label.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.prompt.toLowerCase().includes(q)
      );
    }

    return list;
  }, [search, activeCategory, visiblePrompts]);

  // MONEY-228 - dispatch order: tool > navigate > prompt.
  const handleClick = (item: PromptItem) => {
    if (item.navigateTo) {
      router.push(item.navigateTo);
      return;
    }
    if (item.tool) {
      const params = new URLSearchParams({
        tool: item.tool,
        userText: item.prompt,
      });
      if (item.params) {
        params.set("toolParams", JSON.stringify(item.params));
      }
      router.push(`/stocksage?${params.toString()}`);
      return;
    }
    router.push(`/stocksage?prompt=${encodeURIComponent(item.prompt)}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Search bar */}
      <div
        style={{
          padding: "12px 16px",
          borderRadius: 12,
          border: "2px solid var(--ink)",
          background: "var(--paper-3)",
          display: "flex",
          gap: 12,
          alignItems: "center",
          boxShadow: "var(--shadow-soft)",
        }}
      >
        <Search
          style={{
            width: 18,
            height: 18,
            color: "var(--ink-3)",
            flexShrink: 0,
          }}
        />
        <input
          type="text"
          placeholder="Search prompts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            border: 0,
            outline: 0,
            background: "transparent",
            fontFamily: "Inter, sans-serif",
            fontSize: 15,
            color: "var(--ink)",
          }}
        />
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-3)",
            padding: "2px 7px",
            borderRadius: 4,
            background: "var(--rule-softer)",
            border: "1.5px solid var(--rule-soft)",
            flexShrink: 0,
          }}
        >
          ⌘ K
        </span>
      </div>

      {/* Category filter pills — wrap, never scroll */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          onClick={() => setActiveCategory("all")}
          style={{
            padding: "6px 13px",
            borderRadius: 999,
            fontFamily: "Inter, sans-serif",
            fontSize: 12.5,
            border: "1.5px solid var(--ink)",
            background:
              activeCategory === "all" ? "var(--ink)" : "var(--paper)",
            color: activeCategory === "all" ? "var(--paper)" : "var(--ink-2)",
            cursor: "pointer",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          All{" "}
          <span className="mono" style={{ fontSize: 10.5, opacity: 0.7 }}>
            ({visiblePrompts.length})
          </span>
        </button>
        {visibleCategories.map((cat) => {
          const count = visiblePrompts.filter(
            (p) => p.category === cat.id
          ).length;
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCategory(cat.id)}
              style={{
                padding: "6px 13px",
                borderRadius: 999,
                fontFamily: "Inter, sans-serif",
                fontSize: 12.5,
                border: "1.5px solid var(--ink)",
                background: isActive ? "var(--ink)" : "var(--paper)",
                color: isActive ? "var(--paper)" : "var(--ink-2)",
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {cat.label}{" "}
              <span className="mono" style={{ fontSize: 10.5, opacity: 0.7 }}>
                ({count})
              </span>
            </button>
          );
        })}
      </div>

      {/* Prompt grid */}
      {filtered.length === 0 ? (
        <div
          className="pf-card"
          style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}
        >
          <Search
            style={{
              width: 32,
              height: 32,
              margin: "0 auto 12px",
              opacity: 0.4,
            }}
          />
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            No prompts match your search.
          </div>
          <div
            style={{
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontSize: 14,
              marginTop: 4,
            }}
          >
            Try a different keyword.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {filtered.map((item, idx) => {
            const Icon = iconMap[item.icon] ?? HelpCircle;
            const accent = ACCENT_CYCLE[idx % ACCENT_CYCLE.length];
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleClick(item)}
                className="pf-card"
                style={{
                  padding: "14px 14px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  cursor: "pointer",
                  background: "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  borderRadius: 11,
                  boxShadow: "none",
                  textAlign: "left",
                  transition: "transform .12s, box-shadow .12s",
                  width: "100%",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translate(-1px,-1px)";
                  e.currentTarget.style.boxShadow = "2px 2px 0 var(--ink)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translate(0,0)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: accent,
                    border: "1.5px solid var(--ink)",
                    color: "#fff",
                    display: "grid",
                    placeItems: "center",
                    transform: "rotate(-3deg)",
                    flexShrink: 0,
                  }}
                >
                  <Icon style={{ width: 14, height: 14 }} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--ink)",
                      lineHeight: 1.2,
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--ink-3)",
                      marginTop: 3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.description}
                  </div>
                </div>
                <ArrowRight
                  style={{
                    width: 13,
                    height: 13,
                    color: "var(--ink-3)",
                    flexShrink: 0,
                  }}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
