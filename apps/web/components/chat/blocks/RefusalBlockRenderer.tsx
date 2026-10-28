"use client";

import type { RefusalBlock } from "@usemoney/types";
import "./chat-blocks.css";

interface RefusalBlockRendererProps {
  block: RefusalBlock;
  /** Click handler - fired with the chip's prompt text. */
  onSelectSuggestion?: (prompt: string) => void;
}

export default function RefusalBlockRenderer({
  block,
  onSelectSuggestion,
}: RefusalBlockRendererProps) {
  return (
    <div className="cb-refusal" style={{ margin: "6px 0" }}>
      {/* Sparkles icon — calm, small */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ flexShrink: 0, marginTop: 2 }}
          aria-hidden
        >
          <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17 5.8 21.3l2.4-7.4L2 9.4h7.6z" />
        </svg>
        <p className="cb-refusal-msg">{block.message}</p>
      </div>

      {block.suggestions.length > 0 && (
        <div style={{ marginTop: 12, paddingLeft: 25 }}>
          <div
            className="cb-label"
            style={{ marginBottom: 8, display: "block" }}
          >
            Try asking
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {block.suggestions.map((suggestion: string) => (
              <button
                key={suggestion}
                type="button"
                className="cb-suggestion-chip"
                onClick={() => onSelectSuggestion?.(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
