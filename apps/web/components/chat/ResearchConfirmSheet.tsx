"use client";

/**
 * ResearchConfirmSheet — playful re-skin (MONEY-484).
 *
 * All logic (useResearchPlanPreview, diff, skill editor, model selection)
 * is preserved verbatim. Only the JSX chrome is re-styled with pf-* tokens
 * from playful-app.css. Per the design spec (screens-qa-system.jsx
 * ResearchConfirmSheet) the depth-picker cards now use the radio-option
 * pattern with coloured credit pills.
 *
 * Compact mapping from multi-skill preset → L1/L2/L3 display labels:
 *   quick-pulse        → L1 · Quick scorecard
 *   investment-thesis  → L2 · Research dive
 *   comprehensive      → L2+ / L3-like
 *   l4-institutional   → L3 · Full thesis
 *   custom             → Custom
 */

import { useState, useMemo } from "react";
import {
  Sparkles,
  Settings2,
  X,
  Check,
  Loader2,
  Plus,
  Minus,
} from "lucide-react";
import {
  RESEARCH_PRESET_DEFS,
  RESEARCH_SKILL_LABELS,
  type ResearchPresetId,
  type ResearchSkillId,
} from "@usemoney/services/preferences";
import { useResearchPlanPreview } from "@/hooks/useResearchPlanPreview";

interface ResearchConfirmSheetProps {
  open: boolean;
  query: string;
  symbols?: string[];
  preset?: ResearchPresetId;
  initialSkills: ResearchSkillId[];
  initialModel: string;
  onConfirm: (input: {
    query: string;
    skills: ResearchSkillId[];
    model: string;
  }) => void;
  onCancel: () => void;
}

// Map presets to L-level display labels + credit costs for the picker
const DEPTH_OPTIONS = [
  {
    l: "L1 · Quick scorecard",
    d: "Single-skill, ~30s response. Good for a snapshot.",
    credits: 1,
    time: "~30s",
    color: "var(--emerald)",
    presetHint: "quick-pulse",
  },
  {
    l: "L2 · Research dive",
    d: "Multi-skill, citations, peer comparison.",
    credits: 3,
    time: "~3 min",
    color: "var(--pop-3)",
    presetHint: "investment-thesis",
    default: true,
  },
  {
    l: "L3 · Full thesis",
    d: "Bull/bear case, DCF, earnings quality, full report.",
    credits: 10,
    time: "~12 min",
    color: "var(--pop-5)",
    presetHint: "l4-institutional",
  },
] as const;

export default function ResearchConfirmSheet({
  open,
  query,
  symbols,
  preset,
  initialSkills,
  initialModel,
  onConfirm,
  onCancel,
}: ResearchConfirmSheetProps) {
  const [editedQuery, setEditedQuery] = useState(query);
  const [skills, setSkills] = useState<ResearchSkillId[]>(initialSkills);
  const [model, setModel] = useState(initialModel);
  const [showSkillEditor, setShowSkillEditor] = useState(false);

  // Which depth option is active (default: L2)
  const [selectedDepthIdx, setSelectedDepthIdx] = useState(1);

  const diff = useMemo(() => {
    if (!preset || preset === "custom") return null;
    const defaults = RESEARCH_PRESET_DEFS[preset]?.defaultSkills ?? [];
    const added = skills.filter((s) => !defaults.includes(s));
    const removed = defaults.filter((s) => !skills.includes(s));
    return { added, removed };
  }, [preset, skills]);

  const previewInput = open
    ? {
        query: editedQuery,
        symbols,
        preset,
        customSkills: preset ? undefined : skills,
        extraSkills: diff?.added,
        removedSkills: diff?.removed,
        model,
      }
    : null;

  const { data: preview, isLoading } = useResearchPlanPreview(previewInput, {
    enabled: open,
  });

  if (!open) return null;

  const presetLabel = preset
    ? (RESEARCH_PRESET_DEFS[preset]?.shortLabel ?? preset)
    : "Custom";

  const activeDepth = DEPTH_OPTIONS[selectedDepthIdx];

  return (
    <div
      className="fixed inset-0 z-[300] flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="research-confirm-title"
    >
      {/* Scrim */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
        onClick={onCancel}
      />

      {/* Sheet */}
      <div
        className="relative w-full sm:max-w-[560px] rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          boxShadow: "6px 6px 0 var(--ink)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {/* Header band */}
        <div
          style={{
            padding: "16px 22px",
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--emerald)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            <Sparkles style={{ width: 15, height: 15 }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: "-0.3px",
                color: "var(--ink)",
              }}
              id="research-confirm-title"
            >
              This needs a <span className="ser">deep dive.</span> Pick depth.
            </div>
            <div
              className="mono"
              style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 1 }}
            >
              STOCKSAGE SUGGESTS ·{" "}
              {symbols?.[0] ? symbols[0] : presetLabel.toUpperCase()}
              {diff &&
                (diff.added.length > 0 || diff.removed.length > 0) &&
                ` · ${diff.added.length > 0 ? `+${diff.added.length}` : ""}${diff.removed.length > 0 ? ` −${diff.removed.length}` : ""}`}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1.5px solid var(--ink)",
              display: "grid",
              placeItems: "center",
              background: "var(--paper)",
              color: "var(--ink)",
              cursor: "pointer",
              flexShrink: 0,
            }}
            aria-label="Cancel"
          >
            <X style={{ width: 13, height: 13 }} />
          </button>
        </div>

        <div style={{ padding: 22 }}>
          {/* Editable query */}
          <label style={{ display: "block", marginBottom: 16 }}>
            <span
              className="mono"
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--ink-3)",
                letterSpacing: "1.2px",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Query
            </span>
            <textarea
              value={editedQuery}
              maxLength={1000}
              onChange={(e) => setEditedQuery(e.target.value)}
              rows={2}
              className="pf-input"
              style={{ resize: "vertical", fontSize: 13.5 }}
            />
          </label>

          {/* Depth picker cards */}
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--ink-3)",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            STOCKSAGE SUGGESTS
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginBottom: 16,
            }}
          >
            {DEPTH_OPTIONS.map((opt, i) => {
              const selected = selectedDepthIdx === i;
              return (
                <label
                  key={opt.l}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "14px 16px",
                    border: `2px solid ${selected ? "var(--emerald)" : "var(--ink)"}`,
                    borderRadius: 12,
                    background: selected ? "var(--emerald-bg)" : "var(--paper)",
                    cursor: "pointer",
                    boxShadow: selected ? "3px 3px 0 var(--emerald)" : "none",
                  }}
                >
                  <input
                    type="radio"
                    name="depth"
                    checked={selected}
                    onChange={() => setSelectedDepthIdx(i)}
                    style={{ display: "none" }}
                  />
                  {/* Radio dot */}
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 99,
                      border: "1.5px solid var(--ink)",
                      background: selected ? "var(--emerald)" : "var(--paper)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    {selected && (
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 99,
                          background: "var(--paper)",
                        }}
                      />
                    )}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 800,
                          letterSpacing: "-0.3px",
                          color: "var(--ink)",
                        }}
                      >
                        {opt.l}
                      </span>
                      <span
                        className="pf-pill"
                        style={{
                          fontSize: 9.5,
                          background: opt.color,
                          color: "var(--paper)",
                          borderColor: opt.color,
                          padding: "2px 8px",
                        }}
                      >
                        {opt.credits} cr
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 12,
                        color: "var(--ink-3)",
                        lineHeight: 1.4,
                      }}
                    >
                      {opt.d}
                    </div>
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      flexShrink: 0,
                    }}
                  >
                    {opt.time}
                  </span>
                </label>
              );
            })}
          </div>

          {/* Plan estimate strip */}
          {(isLoading || preview) && (
            <div
              style={{
                padding: 12,
                background: "var(--rule-softer)",
                borderRadius: 9,
                marginBottom: 14,
              }}
            >
              {isLoading && !preview ? (
                <div
                  className="mono"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--ink-3)",
                  }}
                >
                  <Loader2
                    style={{
                      width: 12,
                      height: 12,
                      color: "var(--emerald-text)",
                      animation: "spin 1s linear infinite",
                    }}
                  />
                  Computing estimate…
                </div>
              ) : preview ? (
                <div
                  className="mono"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11.5,
                    color: "var(--ink-3)",
                  }}
                >
                  <span>
                    After:{" "}
                    <strong style={{ color: "var(--emerald-text)" }}>
                      {preview.estimatedCredits} credits
                    </strong>{" "}
                    · ~{preview.estimatedSecondsRange.min}–
                    {preview.estimatedSecondsRange.max}s
                  </span>
                  <span>
                    {preview.estimatedTasks.total} tasks ·{" "}
                    {preview.effectiveSkills.length} skills
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {/* Skill diff chips */}
          {diff && (diff.added.length > 0 || diff.removed.length > 0) && (
            <div style={{ marginBottom: 14 }}>
              {diff.added.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                  >
                    Added:
                  </span>
                  {diff.added.map((s) => (
                    <Chip
                      key={s}
                      label={RESEARCH_SKILL_LABELS[s]}
                      icon={Plus}
                      variant="add"
                    />
                  ))}
                </div>
              )}
              {diff.removed.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                  >
                    Removed:
                  </span>
                  {diff.removed.map((s) => (
                    <Chip
                      key={s}
                      label={RESEARCH_SKILL_LABELS[s]}
                      icon={Minus}
                      variant="remove"
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Model badge */}
          {preview && (
            <div
              style={{
                marginBottom: 14,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--ink-3)",
              }}
            >
              <Settings2 style={{ width: 12, height: 12 }} />
              <span className="mono">
                Model:{" "}
                <strong style={{ color: "var(--ink)" }}>
                  {preview.modelId}
                </strong>{" "}
                · {preview.modelTierLabel}
              </span>
            </div>
          )}

          {/* Inline skill editor */}
          {showSkillEditor && (
            <SkillEditor
              value={skills}
              onChange={setSkills}
              onClose={() => setShowSkillEditor(false)}
            />
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            background: "var(--paper-2)",
          }}
        >
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => setShowSkillEditor((s) => !s)}
          >
            {showSkillEditor ? "Hide skills" : "Edit skills"}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="pf-bf sm" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="pf-bs sm"
              onClick={() =>
                onConfirm({
                  query: editedQuery.trim() || query,
                  skills,
                  model,
                })
              }
            >
              <Sparkles style={{ width: 11, height: 11 }} />
              Run {activeDepth.l.split(" ")[0]} · {activeDepth.credits} credits
              →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Chip({
  label,
  icon: Icon,
  variant,
}: {
  label: string;
  icon: React.ComponentType<{ style?: React.CSSProperties }>;
  variant: "add" | "remove";
}) {
  const isAdd = variant === "add";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10.5,
        fontWeight: 700,
        border: `1.5px solid ${isAdd ? "var(--emerald)" : "var(--pop-1)"}`,
        background: isAdd ? "var(--emerald-bg)" : "rgba(255,107,53,0.08)",
        color: isAdd ? "var(--emerald-text)" : "var(--pop-1-text)",
      }}
    >
      <Icon
        style={{
          width: 10,
          height: 10,
        }}
      />
      {label}
    </span>
  );
}

function SkillEditor({
  value,
  onChange,
  onClose,
}: {
  value: ResearchSkillId[];
  onChange: (next: ResearchSkillId[]) => void;
  onClose: () => void;
}) {
  const allSkills = Object.keys(RESEARCH_SKILL_LABELS) as ResearchSkillId[];
  const v2 = allSkills.filter(
    (s) => !RESEARCH_SKILL_LABELS[s].endsWith("(legacy)")
  );
  return (
    <div
      style={{
        marginBottom: 14,
        maxHeight: 240,
        overflowY: "auto",
        borderRadius: 10,
        border: "1.5px solid var(--rule-soft)",
        background: "var(--paper-2)",
        padding: 10,
      }}
    >
      <div
        style={{
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            color: "var(--ink-3)",
            letterSpacing: "1.2px",
            textTransform: "uppercase",
          }}
        >
          Edit skills
        </span>
        <button
          type="button"
          className="pf-bf sm"
          style={{ padding: "3px 8px", fontSize: 11 }}
          onClick={onClose}
        >
          Done
        </button>
      </div>
      {v2.map((s) => {
        const on = value.includes(s);
        return (
          <button
            key={s}
            type="button"
            onClick={() =>
              onChange(on ? value.filter((x) => x !== s) : [...value, s])
            }
            style={{
              display: "flex",
              width: "100%",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 7,
              textAlign: "left",
              background: on ? "var(--emerald-bg)" : "transparent",
              cursor: "pointer",
              border: 0,
              color: "var(--ink)",
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                border: `1.5px solid ${on ? "var(--emerald)" : "var(--ink)"}`,
                background: on ? "var(--emerald)" : "transparent",
                display: "grid",
                placeItems: "center",
                color: "var(--paper)",
                flexShrink: 0,
              }}
            >
              {on && <Check style={{ width: 10, height: 10 }} />}
            </span>
            <span style={{ fontSize: 12.5, flex: 1 }}>
              {RESEARCH_SKILL_LABELS[s]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
