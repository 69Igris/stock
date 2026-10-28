"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import "./bits.css";

/**
 * PfPositionTable — a generic, typed positions / holdings table.
 *
 * The table itself scrolls horizontally (overflow-x: auto on the wrapper);
 * the surrounding page must NOT scroll horizontally.
 *
 * Features:
 *  - Typed column + row props (no `any`)
 *  - Optional sticky first column
 *  - Built-in header row with title, refresh chip slot, and actions slot
 *  - Real broker logos from /public/brokers/*.png via next/image
 *  - Theme-aware (CSS vars)
 *  - No buy/sell/hold signals — informational only
 */

/* ── Column descriptor ─────────────────────────────────────────────── */
export type CellAlignment = "left" | "right" | "center";

export interface ColumnDef<TRow> {
  /** Unique column key */
  key: string;
  /** Header label shown in <th> */
  label: ReactNode;
  /** Alignment for both header and cells */
  align?: CellAlignment;
  /** If true, marks <th> + <td> with the sticky CSS class */
  sticky?: boolean;
  /** Cell renderer — receives the row data */
  render: (row: TRow, rowIndex: number) => ReactNode;
}

/* ── Built-in row shape for the default Holdings demo ──────────────── */
export interface PositionRow {
  sym: string;
  name: string;
  qty: number;
  avgPrice: number;
  ltp: number;
  broker?:
    | "zerodha"
    | "upstox"
    | "angel"
    | "dhan"
    | "fyers"
    | "groww"
    | "hdfc"
    | "icici";
  totalInvested?: number; // used for allocation % if provided
}

/* ── Table props ───────────────────────────────────────────────────── */
export interface PfPositionTableProps<TRow = PositionRow> {
  columns: ColumnDef<TRow>[];
  rows: TRow[];
  /** Row key extractor — defaults to row index */
  getRowKey?: (row: TRow, index: number) => string | number;
  /** Shown in the header bar */
  title?: ReactNode;
  /** Slot for right-side header actions (buttons, refresh chip, etc.) */
  headerRight?: ReactNode;
  /** Whether to show the top header bar at all */
  showHeader?: boolean;
}

function alignStyle(align?: CellAlignment): React.CSSProperties {
  if (!align || align === "left") return {};
  return { textAlign: align };
}

/* ── Generic table ─────────────────────────────────────────────────── */
export function PfPositionTable<TRow = PositionRow>({
  columns,
  rows,
  getRowKey,
  title = "HOLDINGS",
  headerRight,
  showHeader = true,
}: PfPositionTableProps<TRow>) {
  return (
    <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
      {/* Header bar */}
      {showHeader && (
        <div className="bits-tbl-header-row">
          <span className="bits-tbl-title">{title}</span>
          {headerRight}
        </div>
      )}

      {/* Horizontally scrollable table */}
      <div className="bits-table-wrap">
        <table className="bits-tbl">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={col.sticky ? "sticky" : undefined}
                  style={alignStyle(col.align)}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={getRowKey ? getRowKey(row, ri) : ri}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={col.sticky ? "sticky" : undefined}
                    style={alignStyle(col.align)}
                  >
                    {col.render(row, ri)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default PfPositionTable;

/* ──────────────────────────────────────────────────────────────────────
   Pre-built column definitions for the default Holdings view.
   Pass these to PfPositionTable for a zero-config holdings table.
   ────────────────────────────────────────────────────────────────────── */

/** Formats a number as Indian-locale currency, no decimal for large values */
function fmtRs(n: number, decimals = 2) {
  return (
    "₹" +
    n.toLocaleString("en-IN", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

const TOTAL_PORTFOLIO = 250_000; // used for allocation bar — override if needed

export const DEFAULT_POSITION_COLUMNS: ColumnDef<PositionRow>[] = [
  {
    key: "symbol",
    label: "Symbol",
    sticky: true,
    render: (row) => (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="bits-sym-icon" aria-hidden>
          {row.sym[0]}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="bits-sym-ticker">{row.sym}</div>
          <div className="bits-sym-name">{row.name}</div>
        </div>
      </div>
    ),
  },
  {
    key: "qty",
    label: "Qty",
    align: "right",
    render: (row) => <span className="num">{row.qty}</span>,
  },
  {
    key: "avg",
    label: "Avg",
    align: "right",
    render: (row) => (
      <span className="num" style={{ color: "var(--ink-3)" }}>
        {fmtRs(row.avgPrice)}
      </span>
    ),
  },
  {
    key: "ltp",
    label: "LTP",
    align: "right",
    render: (row) => (
      <span className="num" style={{ fontWeight: 700 }}>
        {fmtRs(row.ltp)}
      </span>
    ),
  },
  {
    key: "pnl",
    label: "P&L",
    align: "right",
    render: (row) => {
      const pnl = (row.ltp - row.avgPrice) * row.qty;
      const pct = ((row.ltp - row.avgPrice) / row.avgPrice) * 100;
      const pos = pnl >= 0;
      return (
        <div>
          <div
            className={`num ${pos ? "pos" : "neg"}`}
            style={{ fontWeight: 800 }}
          >
            {pos ? "+" : "−"}
            {fmtRs(Math.abs(pnl), 0)}
          </div>
          <div
            className={`num ${pos ? "pos" : "neg"}`}
            style={{ fontSize: 11, marginTop: 1 }}
          >
            {pos ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
          </div>
        </div>
      );
    },
  },
  {
    key: "allocation",
    label: "Allocation",
    render: (row) => {
      const val = row.ltp * row.qty;
      const allocPct = Math.min((val / TOTAL_PORTFOLIO) * 100, 100);
      return (
        <div>
          <div className="bits-alloc-bar-track">
            <div
              className="bits-alloc-bar-fill"
              style={{ width: `${allocPct}%` }}
            />
          </div>
          <div className="bits-alloc-label">
            {(val / 100_000).toFixed(2)}L · {allocPct.toFixed(1)}%
          </div>
        </div>
      );
    },
  },
  {
    key: "broker",
    label: "Broker",
    align: "right",
    render: (row) =>
      row.broker ? (
        <div className="bits-broker-chip" style={{ marginLeft: "auto" }}>
          <Image
            src={`/brokers/${row.broker}.png`}
            alt={row.broker}
            width={16}
            height={16}
            style={{
              width: 16,
              height: 16,
              objectFit: "contain",
              borderRadius: 3,
            }}
          />
          <span className="bits-broker-chip-name">{row.broker}</span>
        </div>
      ) : null,
  },
];

/** Sample rows matching the design prototype */
export const SAMPLE_POSITION_ROWS: PositionRow[] = [
  {
    sym: "RELIANCE",
    name: "Reliance Industries",
    qty: 12,
    avgPrice: 2540.5,
    ltp: 2892.5,
    broker: "zerodha",
  },
  {
    sym: "HDFCBANK",
    name: "HDFC Bank Ltd",
    qty: 30,
    avgPrice: 1612,
    ltp: 1687.8,
    broker: "groww",
  },
  {
    sym: "INFY",
    name: "Infosys",
    qty: 25,
    avgPrice: 1640,
    ltp: 1812.65,
    broker: "zerodha",
  },
  {
    sym: "TCS",
    name: "Tata Consultancy",
    qty: 10,
    avgPrice: 4280,
    ltp: 4105.2,
    broker: "zerodha",
  },
  {
    sym: "ITC",
    name: "ITC Limited",
    qty: 100,
    avgPrice: 410,
    ltp: 448.2,
    broker: "groww",
  },
  {
    sym: "BAJFIN",
    name: "Bajaj Finance",
    qty: 4,
    avgPrice: 6850,
    ltp: 7215.6,
    broker: "zerodha",
  },
];
