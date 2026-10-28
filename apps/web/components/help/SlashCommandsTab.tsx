"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  PieChart,
  Briefcase,
  TrendingUp,
  ArrowUpDown,
  Landmark,
  FileText,
  Flame,
  Search,
  BarChart3,
  Shield,
  Receipt,
  FolderOpen,
  FileSpreadsheet,
  Upload,
  CloudUpload,
  HelpCircle,
  Trash2,
  ArrowRight,
  Copy,
  Check,
  type LucideIcon,
} from "lucide-react";
import {
  SLASH_COMMANDS,
  CATEGORY_META,
  formatParamToken,
  type SlashCommandCategory,
} from "@/lib/chat/slash-commands";

const iconMap: Record<string, LucideIcon> = {
  PieChart,
  Briefcase,
  TrendingUp,
  ArrowUpDown,
  Landmark,
  FileText,
  Flame,
  Search,
  BarChart3,
  Shield,
  Receipt,
  FolderOpen,
  FileSpreadsheet,
  Upload,
  CloudUpload,
  HelpCircle,
  Trash2,
};

const ALL_CATEGORIES: SlashCommandCategory[] = [
  "portfolio",
  "trading",
  "research",
  "tools",
  "utility",
];

/** Accent colour per category */
const CAT_ACCENT: Record<SlashCommandCategory, string> = {
  portfolio: "var(--emerald)",
  trading: "var(--pop-1)",
  research: "var(--pop-3)",
  tools: "var(--pop-5)",
  utility: "var(--pop-2)",
};

export default function SlashCommandsTab() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<
    SlashCommandCategory | "all"
  >("all");
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let list = SLASH_COMMANDS;

    if (activeCategory !== "all") {
      list = list.filter((cmd) => cmd.category === activeCategory);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (cmd) =>
          cmd.name.includes(q) ||
          cmd.description.toLowerCase().includes(q) ||
          cmd.aliases?.some((a) => a.includes(q))
      );
    }

    return list;
  }, [search, activeCategory]);

  const handleCopy = (commandName: string) => {
    navigator.clipboard.writeText(`/${commandName}`);
    setCopiedCommand(commandName);
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  const handleUseCommand = (commandName: string) => {
    router.push(`/stocksage?prompt=${encodeURIComponent(`/${commandName}`)}`);
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
          placeholder="Search commands…"
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
      </div>

      {/* Category filter pills — wrap, never scroll */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          onClick={() => setActiveCategory("all")}
          style={{
            padding: "6px 13px",
            borderRadius: 999,
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
            fontFamily: "Inter, sans-serif",
          }}
        >
          All{" "}
          <span className="mono" style={{ fontSize: 10.5, opacity: 0.7 }}>
            ({SLASH_COMMANDS.length})
          </span>
        </button>
        {ALL_CATEGORIES.map((cat) => {
          const meta = CATEGORY_META[cat];
          const count = SLASH_COMMANDS.filter(
            (cmd) => cmd.category === cat
          ).length;
          const isActive = activeCategory === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              style={{
                padding: "6px 13px",
                borderRadius: 999,
                fontSize: 12.5,
                border: "1.5px solid var(--ink)",
                background: isActive ? "var(--ink)" : "var(--paper)",
                color: isActive ? "var(--paper)" : "var(--ink-2)",
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontFamily: "Inter, sans-serif",
              }}
            >
              {meta.label}{" "}
              <span className="mono" style={{ fontSize: 10.5, opacity: 0.7 }}>
                ({count})
              </span>
            </button>
          );
        })}
      </div>

      {/* Command grid */}
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
            No commands match your search.
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
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 10,
          }}
        >
          {filtered.map((cmd) => {
            const Icon = iconMap[cmd.icon] ?? HelpCircle;
            const isCopied = copiedCommand === cmd.name;
            const accent =
              activeCategory !== "all"
                ? CAT_ACCENT[cmd.category as SlashCommandCategory]
                : (CAT_ACCENT[cmd.category as SlashCommandCategory] ??
                  "var(--emerald)");

            return (
              <div key={cmd.name} className="pf-card" style={{ padding: 14 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      padding: "5px 11px",
                      background: accent,
                      color:
                        accent === "var(--pop-2)" ? "#1d1d1b" : "var(--paper)",
                      border: "1.5px solid var(--ink)",
                      borderRadius: 7,
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 12,
                      fontWeight: 800,
                      transform: "rotate(-2deg)",
                      flexShrink: 0,
                      display: "inline-block",
                    }}
                  >
                    /{cmd.name}
                  </span>
                  {cmd.aliases && cmd.aliases.length > 0 && (
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: "var(--ink-4)" }}
                    >
                      ({cmd.aliases.map((a) => `/${a}`).join(", ")})
                    </span>
                  )}
                </div>

                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--ink-2)",
                    lineHeight: 1.4,
                    margin: "0 0 8px",
                  }}
                >
                  {cmd.description}
                </p>

                {/* Params */}
                {cmd.params && cmd.params.length > 0 && (
                  <div
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      color: "var(--ink-3)",
                      marginBottom: 6,
                    }}
                  >
                    {cmd.params.map((p) => (
                      <div key={p.name} style={{ marginBottom: 2 }}>
                        <span style={{ color: "var(--ink-2)" }}>
                          {formatParamToken(p)}
                        </span>{" "}
                        — {p.description}
                        {p.enumValues && (
                          <span
                            style={{ color: "var(--ink-4)", marginLeft: 4 }}
                          >
                            ({p.enumValues.join(" | ")})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Examples */}
                {cmd.examples.length > 0 && (
                  <div
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      color: "var(--ink-4)",
                      marginBottom: 8,
                    }}
                  >
                    {cmd.examples.map((ex) => (
                      <code key={ex} style={{ marginRight: 8 }}>
                        {ex}
                      </code>
                    ))}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => handleCopy(cmd.name)}
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontWeight: 600,
                      padding: 0,
                    }}
                  >
                    {isCopied ? (
                      <Check
                        style={{
                          width: 12,
                          height: 12,
                          color: "var(--emerald-text)",
                        }}
                      />
                    ) : (
                      <Copy style={{ width: 12, height: 12 }} />
                    )}
                    {isCopied ? "Copied" : "Copy"}
                  </button>
                  {cmd.mode === "tool" && (
                    <button
                      type="button"
                      onClick={() => handleUseCommand(cmd.name)}
                      style={{
                        fontSize: 11,
                        color: "var(--emerald-text)",
                        background: "transparent",
                        border: 0,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontWeight: 700,
                        padding: 0,
                        marginLeft: "auto",
                      }}
                    >
                      Try it
                      <ArrowRight style={{ width: 11, height: 11 }} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
