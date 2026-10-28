"use client";

/**
 * ResearchResultFooter - MONEY-239 C.
 *
 * Renders below a completed research report. Surfaces the four
 * followup actions from the redesign brief:
 *
 *   1. Re-run + skill - "+ Governance Flags" / "+ Forward Scenarios"
 *      Single-skill add. Triggers the same research action with the
 *      preset's skills ∪ {newSkill}.
 *   2. Drop skill next time - "− News & Catalysts"
 *      Single-skill remove from the SAVED preset (so future runs
 *      stay shorter). Persists via setResearchPreferences.
 *   3. Save bundle - opens an inline rename input → calls
 *      saveBundleAction with the current skill set.
 *   4. Share - copies a deep link encoding the preset / skills /
 *      model so a colleague can run the same recipe.
 *
 * Suggestions for (1) and (2) are derived from the SKILL_TOOL_ALLOWLIST
 * + which skills were active in the just-completed run. We pick the
 * single highest-leverage add (a skill the run didn't include but
 * usually pairs well) and the single most-droppable (a skill that
 * fired but added the least to the report - defaulting to
 * forward-scenarios + news-sentiment-catalysts as the typical
 * "extras").
 */

import { useState, useCallback } from "react";
import { Plus, Minus, Bookmark, Share2, Check, X } from "lucide-react";
import {
  RESEARCH_SKILL_LABELS,
  type ResearchSkillId,
  type ResearchPresetId,
} from "@usemoney/services/preferences";
import { saveBundleAction } from "@/lib/actions/saved-bundles";
import { usePfConfirm } from "@/components/ui/use-confirm";

interface ResearchResultFooterProps {
  /** The skills the just-completed run used. */
  activeSkills: ResearchSkillId[];
  /** Preset the user picked, if any. */
  preset?: ResearchPresetId;
  /** Symbol(s) for the deep-link share. */
  symbols?: string[];
  /** Original query for share + bundle naming defaults. */
  query: string;
  /** Triggers a fresh research run with the patched skill set. */
  onRerun?: (skills: ResearchSkillId[]) => void;
  /** Persists the dropped skill to the user's preset prefs. */
  onDropSkillFromPreset?: (skill: ResearchSkillId) => Promise<void>;
}

/**
 * Pick the highest-leverage skill the run didn't include. Today's
 * heuristic: governance flags first (high signal, low cost), then
 * regime volatility, then forward scenarios.
 */
function pickSuggestedAdd(
  activeSkills: readonly ResearchSkillId[]
): ResearchSkillId | null {
  const candidates: ResearchSkillId[] = [
    "governance-flags",
    "regime-volatility",
    "forward-scenarios",
    "macro-sensitivities",
    "quant-factor-scores",
  ];
  for (const c of candidates) {
    if (!activeSkills.includes(c)) return c;
  }
  return null;
}

/**
 * Pick the most-droppable skill the run included. We bias toward
 * skills users frequently drop after seeing them in the report:
 * news (low signal once headlines are stale), forward scenarios
 * (long compute, sometimes redundant), then dividend-income (only
 * meaningful for income stocks).
 */
function pickSuggestedDrop(
  activeSkills: readonly ResearchSkillId[]
): ResearchSkillId | null {
  const candidates: ResearchSkillId[] = [
    "news-sentiment-catalysts",
    "forward-scenarios",
    "dividend-income",
    "chart-pattern-detection",
  ];
  for (const c of candidates) {
    if (activeSkills.includes(c)) return c;
  }
  return null;
}

function buildShareUrl(input: {
  symbols?: string[];
  preset?: ResearchPresetId;
  skills: ResearchSkillId[];
  query: string;
}): string {
  const params = new URLSearchParams();
  if (input.symbols && input.symbols.length > 0) {
    params.set("symbols", input.symbols.join(","));
  }
  if (input.preset) params.set("preset", input.preset);
  if (input.skills.length > 0) {
    params.set("skills", input.skills.join(","));
  }
  params.set("q", input.query);
  return `${typeof window !== "undefined" ? window.location.origin : "https://usemoney.ai"}/stocksage?${params.toString()}`;
}

export default function ResearchResultFooter({
  activeSkills,
  preset,
  symbols,
  query,
  onRerun,
  onDropSkillFromPreset,
}: ResearchResultFooterProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [sharedToast, setSharedToast] = useState(false);
  const { confirm, confirmDialog } = usePfConfirm();
  const [savingMode, setSavingMode] = useState(false);
  const [bundleName, setBundleName] = useState(
    `${symbols?.[0] ?? "Research List"} template`
  );

  const suggestedAdd = pickSuggestedAdd(activeSkills);
  const suggestedDrop = pickSuggestedDrop(activeSkills);

  const handleRerunPlus = useCallback(() => {
    if (!suggestedAdd || !onRerun) return;
    setBusy("add");
    onRerun([...activeSkills, suggestedAdd]);
    setTimeout(() => setBusy(null), 800);
  }, [suggestedAdd, activeSkills, onRerun]);

  const handleDropFromPreset = useCallback(async () => {
    if (!suggestedDrop || !onDropSkillFromPreset) return;
    setBusy("drop");
    try {
      await onDropSkillFromPreset(suggestedDrop);
      setSavedToast(
        `Removed ${RESEARCH_SKILL_LABELS[suggestedDrop]} from default`
      );
      setTimeout(() => setSavedToast(null), 2500);
    } finally {
      setBusy(null);
    }
  }, [suggestedDrop, onDropSkillFromPreset]);

  const handleSaveBundle = useCallback(async () => {
    setBusy("save");
    try {
      const res = await saveBundleAction({
        name: bundleName.trim(),
        skills: activeSkills,
      });
      if (res.success) {
        setSavedToast(`Saved as "${res.data?.name}"`);
        setSavingMode(false);
        setTimeout(() => setSavedToast(null), 2500);
      } else {
        setSavedToast(res.error ?? "Save failed");
        setTimeout(() => setSavedToast(null), 3000);
      }
    } finally {
      setBusy(null);
    }
  }, [bundleName, activeSkills]);

  const handleShare = useCallback(async () => {
    const url = buildShareUrl({ symbols, preset, skills: activeSkills, query });
    try {
      await navigator.clipboard.writeText(url);
      setSharedToast(true);
      setTimeout(() => setSharedToast(false), 2000);
    } catch {
      // Clipboard write blocked — show the link in the styled dialog so the
      // user can select-copy it manually (was a native window.prompt).
      void confirm({
        title: "Copy this link to share",
        description: url,
        confirmLabel: "Done",
        cancelLabel: "Close",
      });
    }
  }, [symbols, preset, activeSkills, query, confirm]);

  if (savingMode) {
    return (
      <div
        className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] p-2.5"
        role="group"
        aria-label="Save research bundle"
      >
        <Bookmark className="h-3.5 w-3.5 text-[var(--accent-primary)] shrink-0" />
        <input
          autoFocus
          value={bundleName}
          maxLength={80}
          onChange={(e) => setBundleName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSaveBundle();
            if (e.key === "Escape") setSavingMode(false);
          }}
          className="flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none"
          placeholder="Template name…"
        />
        <button
          type="button"
          onClick={handleSaveBundle}
          disabled={busy === "save" || !bundleName.trim()}
          className="rounded-md bg-emerald-400 px-2 py-1 text-[11px] font-semibold text-[#16140e] disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setSavingMode(false)}
          className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      {confirmDialog}
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Research follow-up actions"
      >
        {suggestedAdd && onRerun && (
          <FooterChip
            icon={Plus}
            disabled={busy === "add"}
            onClick={handleRerunPlus}
            label={`Re-run + ${RESEARCH_SKILL_LABELS[suggestedAdd]}`}
            variant="primary"
          />
        )}
        {suggestedDrop && onDropSkillFromPreset && (
          <FooterChip
            icon={Minus}
            disabled={busy === "drop"}
            onClick={handleDropFromPreset}
            label={`Drop ${RESEARCH_SKILL_LABELS[suggestedDrop]} next time`}
            variant="ghost"
          />
        )}
        <FooterChip
          icon={Bookmark}
          disabled={busy === "save"}
          onClick={() => setSavingMode(true)}
          label="Save this bundle"
          variant="ghost"
        />
        <FooterChip
          icon={sharedToast ? Check : Share2}
          onClick={handleShare}
          label={sharedToast ? "Link copied" : "Share"}
          variant="ghost"
        />
      </div>
      {savedToast && (
        <div
          role="status"
          className="text-[11.5px] text-emerald-400"
          aria-live="polite"
        >
          {savedToast}
        </div>
      )}
    </div>
  );
}

function FooterChip({
  icon: Icon,
  label,
  onClick,
  disabled,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant: "primary" | "ghost";
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20"
      : "border-[var(--border-default)] bg-transparent text-[var(--text-dim)] hover:text-[var(--text-primary)] hover:bg-white/[0.04]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles}`}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}
