"use client";

import { useState } from "react";
import type { ResearchPromptBlock } from "@usemoney/types";
import {
  Brain,
  Zap,
  LineChart,
  Newspaper,
  Users,
  FileText,
  X,
  Check,
} from "lucide-react";
import "./chat-blocks.css";

const ICON_MAP: Record<
  string,
  React.ComponentType<{ style?: React.CSSProperties }>
> = {
  research: Brain,
  quick: Zap,
  technical: LineChart,
  news: Newspaper,
  peer: Users,
  thesis: FileText,
};

// Accent colours per option type. These are applied as icon text-markers
// next to option labels, so they use the AA-contrast -text variants.
const OPTION_ACCENT: Record<string, string> = {
  research: "var(--emerald-text)",
  quick: "var(--pop-2-text)",
  technical: "var(--pop-3-text)",
  news: "var(--pop-1-text)",
  peer: "var(--pop-5-text)",
  thesis: "var(--pop-4-text)",
};

interface ResearchPromptRendererProps {
  block: ResearchPromptBlock;
  onSelect: (
    optionId: string,
    tool: string,
    params: Record<string, unknown>
  ) => void;
  onCancel: () => void;
}

/**
 * ResearchPromptRenderer — playful re-skin (MONEY-484).
 *
 * All functionality (option selection, resolved/cancelled states,
 * hover description) preserved. Re-styled with pf-* tokens:
 * option buttons use the pill-style border cards, selected uses emerald
 * fill with check mark, cancelled muted.
 */
export default function ResearchPromptRenderer({
  block,
  onSelect,
  onCancel,
}: ResearchPromptRendererProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const isResolved = block.status !== "pending";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Title */}
      <p
        style={{
          fontSize: 13.5,
          fontWeight: 700,
          color: "var(--ink)",
          lineHeight: 1.4,
        }}
      >
        {block.title}
      </p>

      {/* Option chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {block.options.map((option) => {
          const Icon = ICON_MAP[option.icon || "research"] || Brain;
          const isSelected = block.selectedOptionId === option.id;
          const isDisabled = isResolved && !isSelected;
          const accent =
            OPTION_ACCENT[option.icon || "research"] ?? "var(--emerald-text)";

          return (
            <button
              key={option.id}
              type="button"
              disabled={isResolved}
              onClick={() => onSelect(option.id, option.tool, option.params)}
              onMouseEnter={() => setHoveredId(option.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderRadius: 8,
                fontSize: 12.5,
                fontWeight: 700,
                border: isSelected
                  ? "2px solid var(--emerald)"
                  : isDisabled
                    ? "1.5px solid var(--rule-soft)"
                    : "1.5px solid var(--ink)",
                background: isSelected
                  ? "var(--emerald)"
                  : isDisabled
                    ? "var(--rule-softer)"
                    : "var(--paper)",
                color: isSelected
                  ? "var(--paper)"
                  : isDisabled
                    ? "var(--ink-4)"
                    : "var(--ink)",
                cursor: isResolved ? "default" : "pointer",
                boxShadow: isSelected ? "2px 2px 0 var(--emerald)" : "none",
                transition: "transform 0.1s, box-shadow 0.1s",
                opacity: isDisabled ? 0.55 : 1,
              }}
            >
              {isSelected ? (
                <Check style={{ width: 13, height: 13 }} />
              ) : (
                <Icon
                  style={{
                    width: 13,
                    height: 13,
                    color: isDisabled ? "var(--ink-4)" : accent,
                  }}
                />
              )}
              {option.label}
            </button>
          );
        })}

        {!isResolved && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 11px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              border: "1.5px solid var(--rule-soft)",
              background: "transparent",
              color: "var(--ink-3)",
              cursor: "pointer",
              transition: "border-color 0.1s, color 0.1s",
            }}
          >
            <X style={{ width: 12, height: 12 }} />
            Cancel
          </button>
        )}
      </div>

      {/* Hover description */}
      {hoveredId && !isResolved && (
        <p
          style={{
            fontSize: 12,
            color: "var(--ink-3)",
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
            lineHeight: 1.4,
          }}
        >
          {block.options.find((o) => o.id === hoveredId)?.description}
        </p>
      )}

      {/* Cancelled state */}
      {block.status === "cancelled" && (
        <p
          style={{
            fontSize: 12,
            color: "var(--ink-4)",
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
          }}
        >
          Cancelled
        </p>
      )}
    </div>
  );
}
