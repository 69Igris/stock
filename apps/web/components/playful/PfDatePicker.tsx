"use client";

/**
 * PfDatePicker — a playful, self-contained date picker.
 *
 * Design principles:
 * - Trigger field styled like .pf-input (ink border, paper bg, focus shift)
 * - Calendar popover: month/year nav, day grid, today + selected highlight
 * - Fully theme-aware (CSS vars only — no hardcoded light/dark hex)
 * - Mobile-friendly: popover is width-constrained, never causes horiz scroll
 * - No external deps beyond React
 *
 * Props:
 *   value      ISO date string (yyyy-mm-dd) or empty string
 *   onChange   called with ISO yyyy-mm-dd on day select
 *   id         forwarded to the trigger button
 *   aria-label forwarded to the trigger button
 *   min        ISO yyyy-mm-dd minimum selectable date
 *   max        ISO yyyy-mm-dd maximum selectable date
 *   disabled   disables the trigger
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { usePopoverAnchor } from "@/lib/hooks/usePopoverAnchor";
import "./pf-date-picker.css";

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Parse ISO yyyy-mm-dd → { y, m, d } (month 0-based) */
function parseISO(iso: string): { y: number; m: number; d: number } | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return { y, m: m - 1, d };
}

/** Format { y, m, d } (month 0-based) → yyyy-mm-dd */
function toISO(y: number, m: number, d: number): string {
  return [
    String(y),
    String(m + 1).padStart(2, "0"),
    String(d).padStart(2, "0"),
  ].join("-");
}

/** Format ISO yyyy-mm-dd → DD/MM/YYYY for display */
function fmtDisplay(iso: string): string {
  const p = parseISO(iso);
  if (!p) return "";
  return [
    String(p.d).padStart(2, "0"),
    String(p.m + 1).padStart(2, "0"),
    String(p.y),
  ].join("/");
}

/** Number of days in a month */
function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

/** Day-of-week for the 1st of the month (0 = Sun) */
function firstDayOfWeek(y: number, m: number): number {
  return new Date(y, m, 1).getDay();
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/* ── Calendar icon ──────────────────────────────────────────────────── */
function IconCalendar({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

/* ── Chevron icons ──────────────────────────────────────────────────── */
function IconChevronLeft({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconChevronRight({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/* ── Component ──────────────────────────────────────────────────────── */

export interface PfDatePickerProps {
  value: string;
  onChange: (iso: string) => void;
  id?: string;
  "aria-label"?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  label?: string;
}

export function PfDatePicker({
  value,
  onChange,
  id,
  "aria-label": ariaLabel,
  min,
  max,
  disabled = false,
  label,
}: PfDatePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchor the portaled calendar to the trigger so it overlays OUTSIDE any
  // scrollable ancestor (e.g. the manual-entry modal body) rather than being
  // clipped / forcing the modal to scroll.
  const anchor = usePopoverAnchor(triggerRef, open);

  // Viewing month/year (what the calendar is showing, may differ from selected)
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();

  const parsed = parseISO(value);
  const [viewY, setViewY] = useState(parsed?.y ?? todayY);
  const [viewM, setViewM] = useState(parsed?.m ?? todayM);

  // Keep view in sync with value when it changes externally
  useEffect(() => {
    const p = parseISO(value);
    if (p) {
      setViewY(p.y);
      setViewM(p.m);
    }
  }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      // The calendar is portaled to <body>, outside containerRef — exclude it.
      const inContainer = containerRef.current?.contains(t);
      const inPopover = popoverRef.current?.contains(t);
      if (!inContainer && !inPopover) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") setOpen(false);
  }, []);

  const prevMonth = () => {
    if (viewM === 0) {
      setViewM(11);
      setViewY((y) => y - 1);
    } else {
      setViewM((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewM === 11) {
      setViewM(0);
      setViewY((y) => y + 1);
    } else {
      setViewM((m) => m + 1);
    }
  };

  const selectDay = (d: number) => {
    const iso = toISO(viewY, viewM, d);
    onChange(iso);
    setOpen(false);
  };

  const selectToday = () => {
    const iso = toISO(todayY, todayM, todayD);
    setViewY(todayY);
    setViewM(todayM);
    onChange(iso);
    setOpen(false);
  };

  const clearDate = () => {
    onChange("");
    setOpen(false);
  };

  // Build day cells
  const totalDays = daysInMonth(viewY, viewM);
  const startDow = firstDayOfWeek(viewY, viewM);
  // cells: null = blank leading cell
  const cells: (number | null)[] = [
    ...Array<null>(startDow).fill(null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];

  const isDateDisabled = (d: number): boolean => {
    const iso = toISO(viewY, viewM, d);
    if (min && iso < min) return true;
    if (max && iso > max) return true;
    return false;
  };

  const isSelected = (d: number): boolean => {
    if (!parsed) return false;
    return parsed.y === viewY && parsed.m === viewM && parsed.d === d;
  };

  const isToday = (d: number): boolean =>
    todayY === viewY && todayM === viewM && todayD === d;

  const displayValue = fmtDisplay(value);
  const ariaLabelFinal = ariaLabel ?? label ?? "Select date";

  return (
    <div ref={containerRef} className="pf-dp-root" onKeyDown={handleKeyDown}>
      {label && (
        <label htmlFor={id} className="pf-dp-label">
          {label}
        </label>
      )}

      {/* Trigger */}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`pf-dp-trigger${open ? " is-open" : ""}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-label={ariaLabelFinal}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span
          className={`pf-dp-value${!displayValue ? " pf-dp-placeholder" : ""}`}
        >
          {displayValue || "DD/MM/YYYY"}
        </span>
        <IconCalendar size={14} />
      </button>

      {/* Popover — portaled to <body> so it overlays outside any
          overflow:auto/hidden ancestor (e.g. a scrollable modal body)
          instead of being clipped or forcing the modal to scroll. */}
      {open &&
        anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            className="pf-dp-popover"
            role="dialog"
            aria-label="Date picker calendar"
            aria-modal="false"
            onKeyDown={handleKeyDown}
            style={{
              position: "fixed",
              top: anchor.top + 6,
              left: Math.max(
                8,
                Math.min(anchor.left, window.innerWidth - 280 - 8)
              ),
            }}
          >
            {/* Month/year nav */}
            <div className="pf-dp-nav">
              <button
                type="button"
                className="pf-dp-nav-btn"
                onClick={prevMonth}
                aria-label="Previous month"
              >
                <IconChevronLeft size={12} />
              </button>
              <span className="pf-dp-nav-title">
                {MONTHS[viewM]} {viewY}
              </span>
              <button
                type="button"
                className="pf-dp-nav-btn"
                onClick={nextMonth}
                aria-label="Next month"
              >
                <IconChevronRight size={12} />
              </button>
            </div>

            {/* Weekday header */}
            <div className="pf-dp-grid">
              {DAYS_SHORT.map((d) => (
                <div key={d} className="pf-dp-dow">
                  {d}
                </div>
              ))}

              {/* Day cells */}
              {cells.map((cell, i) => {
                if (cell === null) {
                  return (
                    <div
                      key={`blank-${i}`}
                      className="pf-dp-cell pf-dp-blank"
                    />
                  );
                }
                const disabled = isDateDisabled(cell);
                const selected = isSelected(cell);
                const todayCell = isToday(cell);
                let cls = "pf-dp-cell";
                if (selected) cls += " is-selected";
                else if (todayCell) cls += " is-today";
                if (disabled) cls += " is-disabled";
                return (
                  <button
                    key={cell}
                    type="button"
                    className={cls}
                    onClick={() => !disabled && selectDay(cell)}
                    disabled={disabled}
                    aria-label={`${cell} ${MONTHS[viewM]} ${viewY}${todayCell ? " (today)" : ""}${selected ? " (selected)" : ""}`}
                    aria-pressed={selected}
                    tabIndex={disabled ? -1 : 0}
                  >
                    {cell}
                  </button>
                );
              })}
            </div>

            {/* Footer actions */}
            <div className="pf-dp-footer">
              <button
                type="button"
                className="pf-dp-footer-btn"
                onClick={selectToday}
              >
                Today
              </button>
              <button
                type="button"
                className="pf-dp-footer-btn pf-dp-footer-clear"
                onClick={clearDate}
              >
                Clear
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export default PfDatePicker;
