"use client";

import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { TakeTheTourButton } from "@/components/walkthrough";
import type { SavedScenario } from "../lib/types";

interface ScenarioBarProps {
  savedScenarios: SavedScenario[];
  activeScenarioId: string | null;
  scenarioName: string;
  isPending: boolean;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

export function ScenarioBar({
  savedScenarios,
  activeScenarioId,
  scenarioName,
  isPending,
  onSwitch,
  onNew,
  onRename,
  onDelete,
}: ScenarioBarProps) {
  return (
    <div className="pf-fire-scenario-bar" data-walkthrough="fire-scenario-name">
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 1.5,
          color: "var(--ink-3)",
          textTransform: "uppercase",
        }}
      >
        Scenarios
      </span>

      {savedScenarios.length > 0 && (
        <div style={{ position: "relative" }}>
          <select
            value={activeScenarioId ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              if (id) onSwitch(id);
            }}
            disabled={isPending}
            aria-label="Switch scenario"
            style={{
              appearance: "none",
              WebkitAppearance: "none",
              MozAppearance: "none",
              padding: "6px 28px 6px 12px",
              background: activeScenarioId
                ? "var(--emerald-bg)"
                : "var(--rule-softer)",
              border: "1.5px solid var(--ink)",
              color: activeScenarioId ? "var(--emerald)" : "var(--ink-3)",
              borderRadius: 9999,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              outline: "none",
              minWidth: 140,
              fontFamily: "inherit",
            }}
          >
            <option value="">Saved scenarios…</option>
            {savedScenarios.map((sc) => (
              <option key={sc.id} value={sc.id}>
                {sc.name}
              </option>
            ))}
          </select>
          <ChevronDown
            style={{
              position: "absolute",
              right: 10,
              top: "50%",
              transform: "translateY(-50%)",
              width: 11,
              height: 11,
              color: activeScenarioId ? "var(--emerald)" : "var(--ink-3)",
              pointerEvents: "none",
            }}
          />
        </div>
      )}

      <button
        type="button"
        onClick={onNew}
        className="pf-bf sm"
        style={{ borderStyle: "dashed" }}
      >
        <Plus className="h-3 w-3" /> New
      </button>

      <input
        value={scenarioName}
        onChange={(e) => onRename(e.target.value)}
        placeholder="Plan name"
        aria-label="Scenario name"
        className="pf-input w-full sm:w-[220px]"
        style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }}
      />

      {activeScenarioId && (
        <button
          type="button"
          onClick={onDelete}
          disabled={isPending}
          title="Delete scenario"
          className="pf-bf sm"
          aria-label="Delete scenario"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}

      <TakeTheTourButton
        version="v1-fire"
        className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono text-[var(--ink-3)] hover:text-[var(--emerald)] hover:bg-[var(--emerald-bg)] transition-colors"
      />
    </div>
  );
}
