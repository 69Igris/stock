"use client";

import { useEffect, useRef, useCallback } from "react";
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
  type LucideIcon,
} from "lucide-react";
import type {
  SlashCommand,
  SlashCommandCategory,
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

// Playful accent per category - mirrors the design's grouped palette.
const CATEGORY_COLOR: Record<SlashCommandCategory, string> = {
  portfolio: "var(--emerald)",
  trading: "var(--emerald)",
  research: "var(--pop-5)",
  tools: "var(--pop-3)",
  utility: "var(--ink-3)",
};

// AA-contrast text variants for the same palette (used where the accent is
// applied as text rather than as a fill/border).
const CATEGORY_TEXT_COLOR: Record<SlashCommandCategory, string> = {
  portfolio: "var(--emerald-text)",
  trading: "var(--emerald-text)",
  research: "var(--pop-5-text)",
  tools: "var(--pop-3-text)",
  utility: "var(--ink-3)",
};

/** Pull a "N credit(s)" hint out of the registry description, if present. */
function extractCredit(description: string): string | null {
  const m = description.match(/(\d+)\s*credits?/i);
  return m ? `${m[1]} cr` : null;
}

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  visible: boolean;
}

/** A single slash-command row rendered inside the grouped list. */
function SlashRow({
  cmd,
  index,
  selectedIndex,
  onSelect,
  setItemRef,
}: {
  cmd: SlashCommand;
  index: number;
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  setItemRef: (i: number) => (el: HTMLButtonElement | null) => void;
}) {
  const Icon = iconMap[cmd.icon] ?? HelpCircle;
  const accentColor = CATEGORY_COLOR[cmd.category];
  const accentTextColor = CATEGORY_TEXT_COLOR[cmd.category];
  const credit = extractCredit(cmd.description);
  const isSelected = index === selectedIndex;

  // Build a short args hint from params, e.g. [--broker] [--symbol]
  const argsHint =
    cmd.params && cmd.params.length > 0
      ? cmd.params
          .filter((p) => p.required)
          .map((p) => `[--${p.name}]`)
          .join(" ")
      : null;

  return (
    <button
      ref={setItemRef(index)}
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={() => onSelect(cmd)}
      className="w-full text-left flex items-center gap-3"
      style={{
        padding: "7px 10px",
        borderRadius: 9,
        background: isSelected ? "var(--paper-2)" : "transparent",
        border: isSelected
          ? "1.5px solid var(--rule-soft)"
          : "1.5px solid transparent",
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      {/* Icon square — rotated -3deg playful touch */}
      <span
        className="shrink-0 grid place-items-center"
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          background: accentColor,
          color: "var(--paper)",
          border: "1.5px solid var(--ink)",
          transform: "rotate(-3deg)",
          boxShadow: "2px 2px 0 var(--ink)",
        }}
        aria-hidden
      >
        <Icon size={13} strokeWidth={2.5} />
      </span>

      {/* Command name + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span
            className="mono"
            style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}
          >
            /{cmd.name}
          </span>
          {argsHint && (
            <span
              className="mono truncate"
              style={{ fontSize: 10.5, color: "var(--ink-3)" }}
            >
              {argsHint}
            </span>
          )}
        </div>
        <div
          className="truncate"
          style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 1 }}
        >
          {cmd.description}
        </div>
      </div>

      {/* Credit pill */}
      {credit && (
        <span
          className="mono shrink-0"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: accentTextColor,
            padding: "2px 6px",
            border: `1.5px solid ${accentColor}`,
            borderRadius: 6,
          }}
        >
          {credit}
        </span>
      )}
    </button>
  );
}

export default function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  visible,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const setItemRef = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      itemRefs.current[index] = el;
    },
    []
  );

  if (!visible || commands.length === 0) return null;

  // Group commands by category for the grouped header display.
  // NOTE: GROUP_LABELS and grouping logic must stay inside the function body
  // because they use SlashCommandCategory (a pure type import).
  const GROUP_LABELS: Record<SlashCommandCategory, string> = {
    portfolio: "PORTFOLIO",
    trading: "TRADING",
    research: "RESEARCH",
    tools: "ANALYSIS",
    utility: "SESSION",
  };

  // Build groups while preserving the already-filtered/sorted order.
  const groups: Array<{
    label: string;
    items: Array<{ cmd: (typeof commands)[number]; index: number }>;
  }> = [];
  const seenGroups = new Map<string, number>();
  commands.forEach((cmd, index) => {
    const label = GROUP_LABELS[cmd.category] ?? cmd.category.toUpperCase();
    const existing = seenGroups.get(label);
    if (existing !== undefined) {
      groups[existing]?.items.push({ cmd, index });
    } else {
      seenGroups.set(label, groups.length);
      groups.push({ label, items: [{ cmd, index }] });
    }
  });

  const useGroups = groups.length > 1;

  return (
    <div
      ref={menuRef}
      className="pf-card pf-app absolute bottom-full left-0 right-0 mb-2 max-h-[380px] overflow-hidden z-50"
      style={{ padding: 0, borderRadius: 14, boxShadow: "var(--shadow-hard)" }}
      role="listbox"
      aria-label="Slash command suggestions"
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: "10px 16px",
          borderBottom: "1.5px dashed var(--rule-soft)",
          background: "var(--paper-2)",
        }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 800,
              color: "var(--emerald-text)",
              padding: "1px 7px",
              border: "1.5px solid var(--emerald)",
              borderRadius: 6,
            }}
          >
            /
          </span>
          <span
            style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}
          >
            Slash commands
          </span>
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)" }}
          >
            · {commands.length} available
          </span>
        </div>
        <div className="mono flex items-center gap-1" style={{ fontSize: 9 }}>
          <span
            className="pf-pill outline"
            style={{ fontSize: 9, padding: "1px 5px" }}
          >
            ↑↓
          </span>
          <span
            className="pf-pill outline"
            style={{ fontSize: 9, padding: "1px 5px" }}
          >
            ↵
          </span>
          <span
            className="pf-pill outline"
            style={{ fontSize: 9, padding: "1px 5px" }}
          >
            esc
          </span>
        </div>
      </div>

      <div
        className="overflow-y-auto"
        style={{ maxHeight: 320, padding: "6px 8px" }}
      >
        {useGroups
          ? groups.map((group) => (
              <div key={group.label}>
                {/* Group header */}
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "1.5px",
                    color: "var(--ink-3)",
                    padding: "8px 10px 4px",
                  }}
                >
                  {group.label}
                </div>
                {group.items.map(({ cmd, index }) => (
                  <SlashRow
                    key={cmd.name}
                    cmd={cmd}
                    index={index}
                    selectedIndex={selectedIndex}
                    onSelect={onSelect}
                    setItemRef={setItemRef}
                  />
                ))}
              </div>
            ))
          : commands.map((cmd, index) => (
              <SlashRow
                key={cmd.name}
                cmd={cmd}
                index={index}
                selectedIndex={selectedIndex}
                onSelect={onSelect}
                setItemRef={setItemRef}
              />
            ))}
      </div>
    </div>
  );
}
