"use client";

import { useEffect, useMemo } from "react";
import { prompts } from "@/app/help/lib/prompt-library";
import { cn } from "@usemoney/utils";
import { Sparkles } from "lucide-react";

interface PromptSuggestionsProps {
  query: string;
  visible: boolean;
  onSelect: (prompt: string) => void;
  onClose: () => void;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
}

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return words.every((word) => lower.includes(word));
}

export function useSuggestions(query: string, visible: boolean) {
  return useMemo(() => {
    if (!visible || query.length < 3) return [];
    const matches = prompts.filter(
      (p) => fuzzyMatch(p.label, query) || fuzzyMatch(p.description, query)
    );
    return matches.slice(0, 4);
  }, [query, visible]);
}

export default function PromptSuggestions({
  query,
  visible,
  onSelect,
  onClose,
  selectedIndex,
  onSelectedIndexChange,
}: PromptSuggestionsProps) {
  const suggestions = useSuggestions(query, visible);

  // Reset index when suggestions change
  useEffect(() => {
    onSelectedIndexChange(0);
  }, [suggestions.length, onSelectedIndexChange]);

  if (!visible || suggestions.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50">
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          boxShadow: "4px 4px 0 var(--ink)",
        }}
      >
        <div className="px-3 py-2 border-b border-[var(--rule-soft)] flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-[var(--emerald-text)]" />
          <span className="text-[10px] font-medium text-[var(--ink-3)] uppercase tracking-wider">
            Suggestions
          </span>
        </div>
        <div className="py-1">
          {suggestions.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors",
                index === selectedIndex
                  ? "bg-[var(--emerald-bg)]"
                  : "hover:bg-[var(--rule-softer)]"
              )}
              onClick={() => onSelect(item.prompt)}
              onMouseEnter={() => onSelectedIndexChange(index)}
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-[var(--ink)] truncate">
                  {item.label}
                </p>
                <p className="text-[11px] text-[var(--ink-3)] truncate">
                  {item.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
