"use client";

/**
 * ModelPickerButton - MONEY-229 Phase D.
 *
 * The five Gemini models from `packages/core/src/gemini/model-registry`
 * render as the primary section. Plan-gating dims the rows the user
 * can't pick (with a "PRO+" badge → /pricing) while still showing them
 * so the upgrade path is discoverable. Selection is persisted to
 * `User.preferences.model` via `useComposerPreferences` and the chat
 * route + research action consume that field on next request.
 *
 * Future-provider rows (Claude / GPT / Grok / custom) stay as
 * "Coming soon" placeholders to set roadmap expectations. Their slots
 * activate when the matching provider integration ticket lands.
 */

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@usemoney/ui/popover";
import { ChevronDown, Sparkles, Check, Lock } from "lucide-react";
import { useChatContext } from "@/lib/chat/ChatContext";
import { useComposerPreferences } from "@/hooks/useComposerPreferences";
import {
  getPickerModelsForUser,
  DEFAULT_MODEL_FOR_PLAN,
  isModelAvailableOnPlan,
  type ModelDefinition,
} from "@usemoney/core/gemini/model-registry";
import { useUser } from "@clerk/nextjs";
import { ModelBrandMark } from "./ModelBrandMark";

type ProviderFamily = "gemini" | "claude" | "chatgpt" | "grok" | "custom";

interface DisplayModel {
  id: string;
  name: string;
  vendor: string;
  meta: string;
  family: ProviderFamily;
  badge?: string;
  comingSoon?: boolean;
  available: boolean; // false → plan-gated; true → user can pick
}

// Provider logos render via <ModelBrandMark/> (real brand vectors lifted from
// the landing-page footer) inside a neutral playful chip. `family` selects the
// mark; no more colored letter-glyphs.

// Future-provider stubs - visible to set roadmap expectations. (Claude is no
// longer a stub — real, founder-gated Claude models come from the registry via
// getPickerModelsForUser; non-founders see only Gemini, per MONEY-626.)
const FUTURE_MODELS: Omit<DisplayModel, "available">[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    vendor: "OpenAI",
    meta: "Quick, balanced output",
    family: "chatgpt",
    comingSoon: true,
  },
  {
    id: "grok-4",
    name: "Grok 4",
    vendor: "xAI",
    meta: "X-stream sentiment edge",
    family: "grok",
    comingSoon: true,
  },
  {
    id: "custom",
    name: "Custom endpoint",
    vendor: "Bring-your-own",
    meta: "Plug an OpenAI-compatible URL",
    family: "custom",
    comingSoon: true,
  },
];

function buildCatalog(
  planId: string,
  email: string | null | undefined
): DisplayModel[] {
  const models = getPickerModelsForUser(email, planId).map(
    (m: ModelDefinition): DisplayModel => {
      // MONEY-1274 (#27) — Claude is no longer a special case here. It used to
      // be forced `available: true` because the only way to SEE it was to be
      // the allowlisted founder, so a plan check was redundant. Now that a plan
      // can grant it, Claude must be plan-checked like every other model, or a
      // model the user cannot actually resolve would render as selectable.
      // Still used for the vendor/family LABELS below — it is only the
      // availability bypass that was removed.
      const isClaude = m.provider === "anthropic";
      const available = isModelAvailableOnPlan(m.id, planId as never);
      const isDefault = DEFAULT_MODEL_FOR_PLAN[planId as never] === m.id;
      return {
        id: m.id,
        name: m.displayName,
        vendor: isClaude ? "Anthropic" : "Google",
        meta: m.description ?? "",
        family: isClaude ? "claude" : "gemini",
        // No pricing-tier badge — availability is conveyed by enable/disable.
        badge: isDefault ? "Default" : undefined,
        available,
      };
    }
  );
  return [...models, ...FUTURE_MODELS.map((m) => ({ ...m, available: false }))];
}

export default function ModelPickerButton() {
  const [open, setOpen] = useState(false);
  const { subscriptionAccess } = useChatContext();
  const { prefs, save, isLoading } = useComposerPreferences();
  const { user } = useUser();
  const planId = subscriptionAccess?.planId ?? "FREE";

  const catalog = buildCatalog(planId, user?.primaryEmailAddress?.emailAddress);
  const storedModel = prefs?.model ?? null;
  const selectedId =
    storedModel && catalog.find((m) => m.id === storedModel && m.available)
      ? storedModel
      : (DEFAULT_MODEL_FOR_PLAN[planId as never] ?? "gemini-2.5-flash");

  const active = catalog.find((m) => m.id === selectedId) ?? catalog[0]!;

  const grouped = catalog.reduce<Record<string, DisplayModel[]>>((acc, m) => {
    (acc[m.vendor] ||= []).push(m);
    return acc;
  }, {});

  const handlePick = (m: DisplayModel) => {
    if (!m.available || m.comingSoon || isLoading) return;
    void save({ model: m.id });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${active.name}`}
          data-testid="model-picker-button"
          className="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium shrink-0 transition-colors"
          style={{
            background: open ? "var(--emerald-bg)" : "var(--paper)",
            borderColor: open ? "var(--emerald)" : "var(--ink)",
            color: "var(--ink-2)",
          }}
        >
          <span
            className="grid place-items-center shrink-0"
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              background: "var(--paper)",
              border: "1px solid var(--rule-soft)",
              overflow: "hidden",
            }}
          >
            <ModelBrandMark family={active.family} size={12} />
          </span>
          <span className="text-[var(--ink)]">
            {active.name.replace(/^Gemini /, "").replace(/^Claude /, "")}
          </span>
          <ChevronDown className="w-3 h-3 text-[var(--ink-3)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="w-[348px] p-0 rounded-xl overflow-hidden flex flex-col"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          boxShadow: "4px 4px 0 var(--ink)",
          maxHeight: 460,
          color: "var(--ink)",
        }}
      >
        <div
          className="flex items-center gap-2.5 px-3.5 py-3 border-b shrink-0"
          style={{ borderColor: "var(--rule-soft)" }}
        >
          <Sparkles className="w-[15px] h-[15px] text-[var(--accent-primary)]" />
          <span className="text-[13.5px] font-semibold tracking-tight">
            Choose a model
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {Object.entries(grouped).map(([vendor, models]) => (
            <div key={vendor} className="mb-1">
              <div
                className="font-mono font-bold uppercase"
                style={{
                  padding: "6px 10px",
                  fontSize: 9.5,
                  letterSpacing: 1.5,
                  color: "var(--ink-3)",
                }}
              >
                {vendor}
              </div>
              {models.map((m) => {
                const on = selectedId === m.id;
                const disabled = m.comingSoon || !m.available;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => handlePick(m)}
                    data-testid={`model-row-${m.id}`}
                    data-available={m.available ? "true" : "false"}
                    className="w-full text-left flex items-center gap-2.5 mb-px disabled:opacity-50"
                    style={{
                      padding: "9px 10px",
                      borderRadius: 8,
                      background: on ? "var(--emerald-bg)" : "transparent",
                      border: `1px solid ${on ? "var(--emerald)" : "transparent"}`,
                      cursor: disabled ? "not-allowed" : "pointer",
                      color: "var(--ink)",
                    }}
                  >
                    <span
                      className="grid place-items-center shrink-0"
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 7,
                        background: "var(--paper)",
                        border: "1px solid var(--rule-soft)",
                        overflow: "hidden",
                      }}
                    >
                      <ModelBrandMark family={m.family} size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium">
                          {m.name}
                        </span>
                        {m.badge && (
                          <span
                            className="font-mono uppercase font-bold"
                            style={{
                              fontSize: 8.5,
                              letterSpacing: 0.5,
                              padding: "1px 5px",
                              borderRadius: 4,
                              background:
                                m.badge === "PRO+"
                                  ? "rgba(251,191,36,0.10)"
                                  : m.badge === "Default"
                                    ? "rgba(52,211,153,0.10)"
                                    : "rgba(148,163,184,0.10)",
                              color:
                                m.badge === "PRO+"
                                  ? "#fbbf24"
                                  : m.badge === "Default"
                                    ? "#34d399"
                                    : "#94a3b8",
                            }}
                          >
                            {m.badge}
                          </span>
                        )}
                        {m.comingSoon && (
                          <span
                            className="font-mono uppercase"
                            style={{
                              fontSize: 8.5,
                              letterSpacing: 0.5,
                              padding: "1px 5px",
                              borderRadius: 4,
                              background: "var(--rule-softer)",
                              color: "var(--ink-3)",
                            }}
                          >
                            Coming soon
                          </span>
                        )}
                        {!m.available && !m.comingSoon && (
                          <Lock className="w-2.5 h-2.5 text-[var(--ink-3)]" />
                        )}
                      </div>
                      <div
                        className="text-[var(--ink-3)] mt-px"
                        style={{ fontSize: 11 }}
                      >
                        {m.meta}
                      </div>
                    </div>
                    {on && (
                      <Check className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div
          className="px-3.5 py-2.5 border-t shrink-0"
          style={{
            borderColor: "var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          <p className="text-[10.5px] text-[var(--ink-3)] leading-snug">
            Gemini Flash + Flash Lite are free on every plan. Pro models charge
            a credit premium per research run - see{" "}
            <a
              href="/pricing"
              className="text-[var(--accent-primary)] hover:underline"
            >
              pricing
            </a>
            .
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
