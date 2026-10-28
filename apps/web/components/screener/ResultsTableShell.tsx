"use client";

import type { ReactNode } from "react";

export interface ResultsColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Hide on narrower breakpoints. Tailwind responsive class like "hidden md:table-cell". */
  responsive?: string;
  /** Column width hint. Example: "w-16" or just omit for auto. */
  width?: string;
}

interface ResultsTableShellProps {
  columns: ResultsColumn[];
  /** `<tr>` elements. Parent renders rows; shell only provides the outer frame + header. */
  children: ReactNode;
  /** Empty state rendered when `children` is empty. */
  emptyState?: ReactNode;
  isEmpty?: boolean;
}

/**
 * Outer wrapper for Screener results tables. Provides:
 *  - Gradient card background + border
 *  - Mono uppercase header row
 *  - Horizontal scroll on overflow
 *  - Empty state slot
 *
 * Each mode (stocks / mf / etf) provides its own column defs + row renderer.
 */
export function ResultsTableShell({
  columns,
  children,
  emptyState,
  isEmpty = false,
}: ResultsTableShellProps) {
  return (
    <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table className="pf-tbl">
          <thead>
            <tr>
              {columns.map((col, idx) => (
                <th
                  key={col.key}
                  className={`${col.responsive ?? ""} ${col.width ?? ""}`}
                  style={{
                    textAlign: col.align === "right" ? "right" : "left",
                    paddingLeft: idx === 0 ? 16 : undefined,
                  }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isEmpty ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    padding: "48px 16px",
                    textAlign: "center",
                    color: "var(--ink-3)",
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  {emptyState ?? "No matches. Loosen filters."}
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default ResultsTableShell;
