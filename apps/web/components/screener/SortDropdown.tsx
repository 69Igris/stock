"use client";

/**
 * Sort dropdown for the Screener toolbar (MONEY-243, design Image #42:
 * "Sort: Match score").
 *
 * The sort happens client-side over `results[]` since the server
 * action's response is already capped to a small page (200 rows).
 * Selection persists per-tab in localStorage so reopening the screener
 * doesn't reset to the default.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ArrowDownAZ, ArrowUpZA } from "lucide-react";

/* ── Shared playful trigger / menu styling (MONEY-485) ──────────────────
   The sort affordances are styled like .pf-input triggers (2px ink
   border, paper bg, mono) and the menus mirror .pf-card (ink border +
   offset shadow). Defined once here so the stocks + funds sort controls
   share an identical look without touching the global stylesheet. */
export const SORT_TRIGGER_CLASS =
  "inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] mono text-[12px] font-bold whitespace-nowrap cursor-pointer transition-transform";
export const SORT_TRIGGER_STYLE: CSSProperties = {
  background: "var(--paper)",
  color: "var(--ink)",
  border: "1.5px solid var(--ink)",
};
export const SORT_MENU_STYLE: CSSProperties = {
  background: "var(--paper)",
  border: "2px solid var(--ink)",
  borderRadius: 12,
  boxShadow: "var(--shadow-soft)",
  padding: 4,
};

/** A single selectable row inside a sort menu - emerald-filled when active. */
export function SortMenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-2 rounded-[7px] text-[12px] mono cursor-pointer transition-colors"
      style={
        active
          ? { background: "var(--emerald)", color: "var(--paper)" }
          : { background: "transparent", color: "var(--ink-2)" }
      }
    >
      {children}
    </button>
  );
}

/* Every field carries an asc/desc variant so the direction toggle is
   always meaningful. `match` defaults to desc (best match first); `name`
   defaults to asc (A→Z). The legacy `match` key without a suffix is
   accepted for backwards compatibility with stored localStorage values. */
export type SortKey =
  | "match"
  | "match-desc"
  | "match-asc"
  | "mcap-desc"
  | "mcap-asc"
  | "change-desc"
  | "change-asc"
  | "name-asc"
  | "name-desc";

export const SORT_LABELS: Record<SortKey, string> = {
  match: "Match score",
  "match-desc": "Match score (high → low)",
  "match-asc": "Match score (low → high)",
  "mcap-desc": "Market cap (high → low)",
  "mcap-asc": "Market cap (low → high)",
  "change-desc": "Today % (high → low)",
  "change-asc": "Today % (low → high)",
  "name-asc": "Name (A → Z)",
  "name-desc": "Name (Z → A)",
};

const ALL: SortKey[] = [
  "match",
  "match-asc",
  "mcap-desc",
  "mcap-asc",
  "change-desc",
  "change-asc",
  "name-asc",
  "name-desc",
];

/* =====================================================================
   Sort field / direction split
   The wire-format `SortKey` carries both the axis and the direction
   (e.g. "mcap-desc"). The redesigned toolbar surfaces the two as
   separate controls - `SortKeyDropdown` for the axis and
   `SortDirectionButton` for desc↔asc - so the helpers below normalise
   between the two views.
   ===================================================================== */

export type SortField = "match" | "mcap" | "change" | "name";

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  match: "Match score",
  mcap: "Market cap",
  change: "Today %",
  name: "Name",
};

export const SORT_FIELDS: SortField[] = ["match", "mcap", "change", "name"];

/** Every field now supports both directions so the toggle never sits
 *  in a disabled state. Kept as a function for symmetry with the funds
 *  variant and in case we ever introduce a one-direction-only field. */
export function fieldHasDirection(_field: SortField): boolean {
  return true;
}

export function decomposeSort(key: SortKey): {
  field: SortField;
  dir: "asc" | "desc";
} {
  // Legacy bare "match" stored in localStorage maps to match-desc.
  if (key === "match") return { field: "match", dir: "desc" };
  const [field, dir] = key.split("-") as [SortField, "asc" | "desc"];
  return { field, dir };
}

export function composeSort(field: SortField, dir: "asc" | "desc"): SortKey {
  return `${field}-${dir}` as SortKey;
}

export function useScreenerSort(
  storageKey: string,
  defaultKey: SortKey = "match"
) {
  const [sort, setSort] = useState<SortKey>(defaultKey);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored && ALL.includes(stored as SortKey)) setSort(stored as SortKey);
  }, [storageKey]);
  const update = (next: SortKey) => {
    setSort(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, next);
    }
  };
  return [sort, update] as const;
}

interface SortDropdownProps {
  storageKey: string;
  /** Restrict the menu to a subset (e.g. funds tab can't sort by mcap). */
  options?: SortKey[];
  /** Controlled mode - when both `value` and `onChange` are provided the
   *  parent owns the state and gets each change as it happens (so the
   *  server action can re-run with the new sort). */
  value?: string;
  onChange?: (next: string) => void;
}

export function SortDropdown({
  storageKey,
  options = ALL,
  value,
  onChange,
}: SortDropdownProps) {
  const isControlled = value !== undefined && onChange !== undefined;
  const [internal, setInternal] = useScreenerSort(storageKey);
  const sort = (isControlled ? (value as SortKey) : internal) ?? "match";
  const setSort = (next: SortKey) => {
    if (isControlled) {
      onChange!(next);
    } else {
      setInternal(next);
    }
  };
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Sort: ${SORT_LABELS[sort]}`}
        title={`Sort: ${SORT_LABELS[sort]}`}
        className={`${SORT_TRIGGER_CLASS} sm:max-w-[180px]`}
        style={SORT_TRIGGER_STYLE}
      >
        {/* Mobile: icon-only sort affordance (image #27 pattern) so the
            toolbar fits Cards/Table + Filters + Sort on one row. From sm+
            up we surface the current sort label so the value is glanceable. */}
        <ArrowDownAZ className="h-3.5 w-3.5 shrink-0 sm:hidden" />
        <span className="hidden xl:inline text-[var(--ink-3)]">Sort:</span>
        <span className="hidden sm:inline truncate">{SORT_LABELS[sort]}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <>
          {/* Click-outside catcher */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className="absolute right-0 mt-1 z-40 min-w-[200px]"
            style={SORT_MENU_STYLE}
          >
            {options.map((k) => (
              <SortMenuItem
                key={k}
                active={sort === k}
                onClick={() => {
                  setSort(k);
                  setOpen(false);
                }}
              >
                {SORT_LABELS[k]}
              </SortMenuItem>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* =====================================================================
   Split Sort UI - direction toggle + key dropdown
   Used by the redesigned toolbar (image #30) where the sort affordance
   is broken into:
     - a direction button that flips desc↔asc
     - a name dropdown that picks the field
   The composed `SortKey` is the same shape the rest of the screener
   already understands; this is purely a UI re-skin.
   ===================================================================== */

interface SortKeyDropdownProps {
  value: SortKey;
  onChange: (next: SortKey) => void;
  /** Optional list to restrict the field menu (e.g. funds tab can hide
   *  market cap). Defaults to all four fields. */
  fields?: SortField[];
}

export function SortKeyDropdown({
  value,
  onChange,
  fields = SORT_FIELDS,
}: SortKeyDropdownProps) {
  const { field, dir } = decomposeSort(value);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Sort by ${SORT_FIELD_LABELS[field]}`}
        title={`Sort by ${SORT_FIELD_LABELS[field]}`}
        className={`${SORT_TRIGGER_CLASS} max-w-[160px]`}
        style={SORT_TRIGGER_STYLE}
      >
        <span className="truncate">{SORT_FIELD_LABELS[field]}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className="absolute right-0 mt-1 z-40 min-w-[200px]"
            style={SORT_MENU_STYLE}
          >
            {fields.map((f) => {
              const next = composeSort(f, dir);
              const isActive = field === f;
              return (
                <SortMenuItem
                  key={f}
                  active={isActive}
                  onClick={() => {
                    onChange(next);
                    setOpen(false);
                  }}
                >
                  {SORT_FIELD_LABELS[f]}
                </SortMenuItem>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

interface SortDirectionButtonProps {
  value: SortKey;
  onChange: (next: SortKey) => void;
}

/**
 * Sort direction toggle.
 *
 * Both the label and the icon swap on click - design Image #33 / #34:
 *   desc  →  "Most ↓Z"   (highest first)
 *   asc   →  "Least ↑Z"  (lowest first)
 *
 * Match has no direction; Name is conventionally A→Z only. For those
 * fields the button stays visible at constant width (no layout jitter
 * when the user switches fields) but sits muted + unclickable.
 */
export function SortDirectionButton({
  value,
  onChange,
}: SortDirectionButtonProps) {
  const { field, dir } = decomposeSort(value);
  const Icon = dir === "desc" ? ArrowDownAZ : ArrowUpZA;
  const label = dir === "desc" ? "Most" : "Least";

  return (
    <button
      type="button"
      onClick={() =>
        onChange(composeSort(field, dir === "desc" ? "asc" : "desc"))
      }
      aria-label={`Sort direction: ${dir === "desc" ? "highest first" : "lowest first"} (click to flip)`}
      title={
        dir === "desc"
          ? "Most: highest first (click for least)"
          : "Least: lowest first (click for most)"
      }
      className={SORT_TRIGGER_CLASS}
      style={SORT_TRIGGER_STYLE}
    >
      <span>{label}</span>
      <Icon className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

/** Pure sort applied to ScreenResult-shaped rows. Designed to work with
 *  any row that has at least `{ marketCap, changePercent, name, matchScore }`
 *  but only requires the keys the chosen sort uses. */
export function applySort<
  T extends {
    marketCap?: number | null;
    changePercent?: number | null;
    name?: string;
    matchScore?: number;
  },
>(rows: T[], key: SortKey): T[] {
  const copy = [...rows];
  switch (key) {
    case "match":
    case "match-desc":
      copy.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
      break;
    case "match-asc":
      copy.sort((a, b) => (a.matchScore ?? 0) - (b.matchScore ?? 0));
      break;
    case "mcap-desc":
      copy.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
      break;
    case "mcap-asc":
      copy.sort((a, b) => (a.marketCap ?? 0) - (b.marketCap ?? 0));
      break;
    case "change-desc":
      copy.sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0));
      break;
    case "change-asc":
      copy.sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0));
      break;
    case "name-asc":
      copy.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      break;
    case "name-desc":
      copy.sort((a, b) => (b.name ?? "").localeCompare(a.name ?? ""));
      break;
  }
  return copy;
}

export default SortDropdown;
