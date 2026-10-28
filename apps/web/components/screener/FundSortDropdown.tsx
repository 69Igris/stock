"use client";

/**
 * Sort controls for the Funds & ETFs screener tabs.
 *
 * Originally a unified `FundSortDropdown` (MONEY-243 v3.3). Per user
 * direction (image #74), funds now use the same split-sort UX as stocks:
 * a `FundSortDirectionButton` (Most ↓Z / Least ↑Z) sits next to a
 * `FundSortKeyDropdown` (axis: Match / 1Y / 3Y / 5Y / NAV / AUM).
 *
 * Wire-format keys keep the `field-dir` shape so `applyFundSort` can
 * dispatch on a single string. The legacy `match` and `*-desc` keys
 * remain as aliases for back-compat with stored localStorage values.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ArrowDownAZ, ArrowUpZA } from "lucide-react";
import {
  SORT_TRIGGER_CLASS,
  SORT_TRIGGER_STYLE,
  SORT_MENU_STYLE,
  SortMenuItem,
} from "@/components/screener/SortDropdown";

export type FundSortKey =
  | "match"
  | "match-desc"
  | "match-asc"
  | "nav-desc"
  | "nav-asc"
  | "aum-desc"
  | "aum-asc"
  | "ret1y-desc"
  | "ret1y-asc"
  | "ret3y-desc"
  | "ret3y-asc"
  | "ret5y-desc"
  | "ret5y-asc";

export const FUND_SORT_LABELS: Record<FundSortKey, string> = {
  match: "Match score",
  "match-desc": "Match score (high → low)",
  "match-asc": "Match score (low → high)",
  "nav-desc": "NAV (high → low)",
  "nav-asc": "NAV (low → high)",
  "aum-desc": "AUM (high → low)",
  "aum-asc": "AUM (low → high)",
  "ret1y-desc": "1Y returns (high → low)",
  "ret1y-asc": "1Y returns (low → high)",
  "ret3y-desc": "3Y returns (high → low)",
  "ret3y-asc": "3Y returns (low → high)",
  "ret5y-desc": "5Y returns (high → low)",
  "ret5y-asc": "5Y returns (low → high)",
};

const ALL: FundSortKey[] = [
  "match",
  "match-asc",
  "ret1y-desc",
  "ret1y-asc",
  "ret3y-desc",
  "ret3y-asc",
  "ret5y-desc",
  "ret5y-asc",
  "nav-desc",
  "nav-asc",
  "aum-desc",
  "aum-asc",
];

export type FundSortField =
  | "match"
  | "ret1y"
  | "ret3y"
  | "ret5y"
  | "nav"
  | "aum";

export const FUND_SORT_FIELD_LABELS: Record<FundSortField, string> = {
  match: "Match score",
  ret1y: "1Y returns",
  ret3y: "3Y returns",
  ret5y: "5Y returns",
  nav: "NAV",
  aum: "AUM",
};

export const FUND_SORT_FIELDS: FundSortField[] = [
  "match",
  "ret1y",
  "ret3y",
  "ret5y",
  "nav",
  "aum",
];

export function decomposeFundSort(key: FundSortKey): {
  field: FundSortField;
  dir: "asc" | "desc";
} {
  // Legacy bare "match" stored in localStorage maps to match-desc.
  if (key === "match") return { field: "match", dir: "desc" };
  const [field, dir] = key.split("-") as [FundSortField, "asc" | "desc"];
  return { field, dir };
}

export function composeFundSort(
  field: FundSortField,
  dir: "asc" | "desc"
): FundSortKey {
  return `${field}-${dir}` as FundSortKey;
}

export function useFundSort(
  storageKey: string,
  defaultKey: FundSortKey = "match"
) {
  const [sort, setSort] = useState<FundSortKey>(defaultKey);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored && ALL.includes(stored as FundSortKey)) {
      setSort(stored as FundSortKey);
    }
  }, [storageKey]);
  const update = (next: FundSortKey) => {
    setSort(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, next);
    }
  };
  return [sort, update] as const;
}

interface FundSortDropdownProps {
  storageKey: string;
  options?: FundSortKey[];
  /** Controlled mode - parent owns sort state when both `value` and
   *  `onChange` are provided (used by mf-mode / etf-mode to drive the
   *  server-side sort key passed to the screener action). */
  value?: string;
  onChange?: (next: string) => void;
}

export function FundSortDropdown({
  storageKey,
  options = ALL,
  value,
  onChange,
}: FundSortDropdownProps) {
  const isControlled = value !== undefined && onChange !== undefined;
  const [internal, setInternal] = useFundSort(storageKey);
  const sort = (isControlled ? (value as FundSortKey) : internal) ?? "match";
  const setSort = (next: FundSortKey) => {
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
        title={`Sort: ${FUND_SORT_LABELS[sort]}`}
        className={`${SORT_TRIGGER_CLASS} max-w-[180px]`}
        style={SORT_TRIGGER_STYLE}
      >
        <span className="hidden xl:inline text-[var(--ink-3)]">Sort:</span>
        <span className="truncate">{FUND_SORT_LABELS[sort]}</span>
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
            className="absolute right-0 mt-1 z-40 min-w-[180px]"
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
                {FUND_SORT_LABELS[k]}
              </SortMenuItem>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface MfSortRow {
  matchScore?: number;
  nav?: number | null;
  aum?: number | null;
  returns1Y?: number | null;
  returns3Y?: number | null;
  returns5Y?: number | null;
}

interface EtfSortRow {
  matchScore?: number;
  ltp?: number | null;
  aum?: number | null;
  returns1Y?: number | null;
}

/** Generic fund-row sort. Works on both MfScreenResult (has nav,
 *  returns3Y/5Y) and EtfScreenResult (has ltp instead of nav, no
 *  returns3Y/5Y - those keys fall through to match-score order). */
export function applyFundSort<T extends MfSortRow & EtfSortRow>(
  rows: T[],
  key: FundSortKey
): T[] {
  const copy = [...rows];
  const num = (v: number | null | undefined): number =>
    v != null && Number.isFinite(v) ? v : 0;
  switch (key) {
    case "match":
    case "match-desc":
      copy.sort((a, b) => num(b.matchScore) - num(a.matchScore));
      break;
    case "match-asc":
      copy.sort((a, b) => num(a.matchScore) - num(b.matchScore));
      break;
    case "nav-desc":
      copy.sort((a, b) => num(b.nav ?? b.ltp) - num(a.nav ?? a.ltp));
      break;
    case "nav-asc":
      copy.sort((a, b) => num(a.nav ?? a.ltp) - num(b.nav ?? b.ltp));
      break;
    case "aum-desc":
      copy.sort((a, b) => num(b.aum) - num(a.aum));
      break;
    case "aum-asc":
      copy.sort((a, b) => num(a.aum) - num(b.aum));
      break;
    case "ret1y-desc":
      copy.sort((a, b) => num(b.returns1Y) - num(a.returns1Y));
      break;
    case "ret1y-asc":
      copy.sort((a, b) => num(a.returns1Y) - num(b.returns1Y));
      break;
    case "ret3y-desc":
      copy.sort((a, b) => num(b.returns3Y) - num(a.returns3Y));
      break;
    case "ret3y-asc":
      copy.sort((a, b) => num(a.returns3Y) - num(b.returns3Y));
      break;
    case "ret5y-desc":
      copy.sort((a, b) => num(b.returns5Y) - num(a.returns5Y));
      break;
    case "ret5y-asc":
      copy.sort((a, b) => num(a.returns5Y) - num(b.returns5Y));
      break;
  }
  return copy;
}

/* ──────────────────────────────────────────────────────────────────
   Split sort UI - direction toggle + axis dropdown.
   Mirrors the SortDirectionButton / SortKeyDropdown pair on the
   stocks screener (image #74 / image #60). Used in the funds toolbar
   at every breakpoint - mobile gets the same controls as desktop.
   ────────────────────────────────────────────────────────────────── */

interface FundSortDirectionButtonProps {
  value: FundSortKey;
  onChange: (next: FundSortKey) => void;
}

export function FundSortDirectionButton({
  value,
  onChange,
}: FundSortDirectionButtonProps) {
  const { field, dir } = decomposeFundSort(value);
  const Icon = dir === "desc" ? ArrowDownAZ : ArrowUpZA;
  const label = dir === "desc" ? "Most" : "Least";
  return (
    <button
      type="button"
      onClick={() =>
        onChange(composeFundSort(field, dir === "desc" ? "asc" : "desc"))
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

interface FundSortKeyDropdownProps {
  value: FundSortKey;
  onChange: (next: FundSortKey) => void;
  /** Optional restriction (e.g. ETF tab can hide 3Y/5Y returns since
   *  EtfScreenResult doesn't carry those columns). Defaults to all. */
  fields?: FundSortField[];
}

export function FundSortKeyDropdown({
  value,
  onChange,
  fields = FUND_SORT_FIELDS,
}: FundSortKeyDropdownProps) {
  const { field, dir } = decomposeFundSort(value);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Sort by ${FUND_SORT_FIELD_LABELS[field]}`}
        title={`Sort by ${FUND_SORT_FIELD_LABELS[field]}`}
        className={`${SORT_TRIGGER_CLASS} max-w-[160px]`}
        style={SORT_TRIGGER_STYLE}
      >
        <span className="truncate">{FUND_SORT_FIELD_LABELS[field]}</span>
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
              const next = composeFundSort(f, dir);
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
                  {FUND_SORT_FIELD_LABELS[f]}
                </SortMenuItem>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default FundSortDropdown;
