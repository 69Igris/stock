"use client";

/**
 * ThinkingToggleButton - MONEY-619 Phase 2.
 *
 * A minimal on/off toggle next to the model picker. When ON, a normal chat
 * turn runs the user's tier's Pro ("deep lane") model instead of Flash and
 * is billed via credits (the chat route charges `l2_chat_thinking` + the
 * per-model premium). Persisted to `User.preferences.thinking` through the
 * same `useComposerPreferences` hook the model picker uses, so the chat
 * route reads it on the next request. Default OFF — casual chat stays free.
 */

import { Brain, Check } from "lucide-react";
import { useComposerPreferences } from "@/hooks/useComposerPreferences";

export default function ThinkingToggleButton() {
  const { prefs, save, isLoading } = useComposerPreferences();
  const on = prefs?.thinking === true;

  const toggle = () => {
    if (isLoading) return;
    void save({ thinking: !on });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={on}
      aria-label="Thinking mode"
      title="Thinking mode — uses a Pro model · costs credits"
      data-testid="thinking-toggle-button"
      data-on={on ? "true" : "false"}
      disabled={isLoading}
      className="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium shrink-0 transition-colors disabled:opacity-50"
      style={{
        background: on ? "var(--emerald-bg)" : "var(--paper)",
        borderColor: on ? "var(--emerald)" : "var(--ink)",
        color: on ? "var(--accent-primary)" : "var(--ink-2)",
      }}
    >
      <Brain className="w-3.5 h-3.5" />
      <span className="text-[var(--ink)]">Thinking</span>
      {on && <Check className="w-3 h-3 text-[var(--accent-primary)]" />}
    </button>
  );
}
