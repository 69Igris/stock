"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Download,
  FileText,
  FileSpreadsheet,
  Braces,
  Receipt,
  Check,
} from "lucide-react";

import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { TradebookSubNav } from "../lib/sub-nav";
import { fyStartYear, fyWindowUtc } from "../lib/range-filter";

import { getTradesAction } from "@/lib/actions/trades";

/* ITR-2 reuses the client-side CSV writer (it is the capital-gains data,
   formatted for spreadsheet import). A dedicated server-side capital-gains
   schedule export is a follow-up — flagged in the UI note, never faked. */
type FormatId = "csv" | "xlsx" | "json" | "itr2";
type RangeId = "7d" | "30d" | "fy" | "pfy" | "all" | "custom";

const FORMATS: {
  id: FormatId;
  lbl: string;
  desc: string;
  icon: typeof FileText;
  featured?: boolean;
}[] = [
  {
    id: "itr2",
    lbl: "ITR-2 · Schedule CG",
    desc: "Maps to ITR-2 capital gains",
    icon: Receipt,
    featured: true,
  },
  {
    id: "xlsx",
    lbl: "Excel (XLSX)",
    desc: "Multi-sheet workbook (CSV today)",
    icon: FileSpreadsheet,
  },
  {
    id: "csv",
    lbl: "CSV",
    desc: "Universal · Excel-compatible",
    icon: FileText,
  },
  {
    id: "json",
    lbl: "JSON",
    desc: "For scripts and APIs",
    icon: Braces,
  },
];

interface TradeRow {
  id: string;
  tradeDate: string | Date;
  symbol: string;
  exchange: string;
  segment: string;
  tradeType: string;
  productType?: string;
  quantity: number;
  price: number;
  broker: string | null;
  brokerName: string | null;
  notes?: string | null;
}

/* Generate the export client-side - no extra round trip needed since we
   already pull trades through getTradesAction. For very large exports this
   would move server-side, but at the current MVP scale a 100-row chunked
   client export is fine and saves us from needing a new server action. */
function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function tradesToCSV(trades: TradeRow[]): string {
  const header = [
    "tradeDate",
    "symbol",
    "exchange",
    "segment",
    "tradeType",
    "productType",
    "quantity",
    "price",
    "total",
    "broker",
    "notes",
  ].join(",");
  const rows = trades.map((t) => {
    const total = t.quantity * t.price;
    const escape = (v: unknown) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    return [
      new Date(t.tradeDate).toISOString(),
      escape(t.symbol),
      escape(t.exchange),
      escape(t.segment),
      escape(t.tradeType),
      escape(t.productType ?? ""),
      t.quantity,
      t.price,
      total,
      escape(t.brokerName ?? t.broker ?? "manual"),
      escape(t.notes ?? ""),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

/* The file extension the download lands with. ITR-2 / XLSX still emit CSV
   client-side today, so the extension reflects the actual file. */
function extFor(fmt: FormatId): string {
  return fmt === "json" ? "json" : "csv";
}

export default function TradebookExportClient() {
  const searchParams = useSearchParams();
  /* Preselect the format the list-page Export dropdown deep-linked to. */
  const initialFmt = ((): FormatId => {
    const q = searchParams.get("format");
    return q === "csv" || q === "xlsx" || q === "json" || q === "itr2"
      ? q
      : "csv";
  })();

  const [fmt, setFmt] = useState<FormatId>(initialFmt);
  const [range, setRange] = useState<RangeId>("fy");
  const [scope, setScope] = useState<"all" | "manual">("all");
  const [includes, setIncludes] = useState({
    trades: true,
    notes: false,
  });
  const [busy, setBusy] = useState(false);
  const [tradeCount, setTradeCount] = useState<number | null>(null);

  /* Fetch a count to display in the preview pane. */
  useEffect(() => {
    void getTradesAction({ skip: 0, limit: 1 }).then((r) => {
      if (r?.success && r?.data) setTradeCount(r.data.total);
    });
  }, []);

  const fileName = `tradebook_${range}_${scope}.${extFor(fmt)}`;

  /* MONEY-847: dynamic FY pill labels derived from now's IST FY (replaces the
     hard-coded "FY 25-26" / "FY 24-25"). */
  const fyLabels = (() => {
    const startYear = fyStartYear(new Date());
    const yy = (y: number) => String(y % 100).padStart(2, "0");
    if (startYear === null) return { fy: "This FY", pfy: "Prev FY" };
    return {
      fy: `FY ${yy(startYear)}-${yy(startYear + 1)}`,
      pfy: `FY ${yy(startYear - 1)}-${yy(startYear)}`,
    };
  })();

  const handleDownload = async () => {
    setBusy(true);
    try {
      const filters: Record<string, unknown> = { skip: 0, limit: 100 };
      if (scope === "manual") filters.broker = "manual";
      const r = await getTradesAction(filters as never);
      if (!r?.success || !r?.data) {
        toast.error(r?.error || "Failed to fetch trades");
        return;
      }
      const trades = r.data.trades as unknown as TradeRow[];
      const filtered = filterByRange(trades, range);
      if (fmt === "json") {
        downloadFile(
          JSON.stringify(filtered, null, 2),
          fileName,
          "application/json"
        );
      } else {
        downloadFile(tradesToCSV(filtered), fileName, "text/csv");
      }
      toast.success(`Downloaded ${filtered.length} trades`);
    } finally {
      setBusy(false);
    }
  };

  const activeFormat = FORMATS.find((f) => f.id === fmt) ?? FORMATS[2];
  const sectionsOn = Object.values(includes).filter(Boolean).length;

  return (
    <TerminalLuxeShell
      active="tradebook"
      title="Export trades"
      breadcrumb="Portfolio · Tradebook"
      onBack={() => {
        if (typeof window !== "undefined") window.history.back();
      }}
    >
      <PfPageHead
        eyebrow="CSV · XLSX · JSON · ITR-2 READY"
        title={
          <>
            Export your <span className="ser">trades.</span>
          </>
        }
        sub="For taxes, accounting, or a backup. Runs client-side from your latest 100 trades."
      />

      <TradebookSubNav active="export" />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 18,
        }}
        className="um-import-grid"
      >
        <div>
          {/* STEP 01 · Format */}
          <div
            className="pf-card"
            data-walkthrough="tradebook-export-format"
            style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}
          >
            <div
              style={{
                padding: "14px 22px",
                borderBottom: "2px solid var(--ink)",
                background: "var(--paper-2)",
              }}
            >
              <div className="ttl">STEP 01 · FORMAT</div>
              <div style={{ marginTop: 4, fontSize: 17, fontWeight: 800 }}>
                Pick a file format.
              </div>
            </div>
            <div
              style={{
                padding: 16,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {FORMATS.map((f) => {
                const a = fmt === f.id;
                const Icon = f.icon;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFmt(f.id)}
                    className="pf-bf"
                    style={{
                      flexDirection: "column",
                      alignItems: "flex-start",
                      padding: 14,
                      gap: 6,
                      borderWidth: 2,
                      background: a
                        ? f.featured
                          ? "var(--pop-2)"
                          : "var(--ink)"
                        : "var(--paper)",
                      color: a
                        ? f.featured
                          ? "#1d1d1b"
                          : "var(--paper)"
                        : "var(--ink)",
                      boxShadow: a ? "3px 3px 0 var(--ink)" : "none",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%",
                        alignItems: "center",
                      }}
                    >
                      <Icon size={18} />
                      {a && <Check size={14} />}
                      {f.featured && !a && (
                        <span
                          className="mono"
                          style={{
                            fontSize: 9,
                            padding: "1px 6px",
                            background: "var(--ink)",
                            color: "var(--pop-2)",
                            borderRadius: 99,
                            fontWeight: 700,
                          }}
                        >
                          POP
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 800,
                        letterSpacing: -0.3,
                      }}
                    >
                      {f.lbl}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        opacity: 0.8,
                        textAlign: "left",
                      }}
                    >
                      {f.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* STEP 02 · Filters */}
          <div
            className="pf-card"
            data-walkthrough="tradebook-export-filters"
            style={{ padding: 0, overflow: "hidden" }}
          >
            <div
              style={{
                padding: "14px 22px",
                borderBottom: "2px solid var(--ink)",
                background: "var(--paper-2)",
              }}
            >
              <div className="ttl">STEP 02 · FILTERS</div>
              <div style={{ marginTop: 4, fontSize: 17, fontWeight: 800 }}>
                What to include.
              </div>
            </div>
            <div
              style={{
                padding: 22,
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}
            >
              {/* Time range */}
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    marginBottom: 8,
                    color: "var(--ink-2)",
                  }}
                >
                  Time range
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(
                    [
                      ["7d", "Last 7d"],
                      ["30d", "Last 30d"],
                      ["fy", fyLabels.fy],
                      ["pfy", fyLabels.pfy],
                      ["all", "All time"],
                      ["custom", "Custom"],
                    ] as [RangeId, string][]
                  ).map(([id, lbl]) => {
                    const a = range === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setRange(id)}
                        className={`pf-pill${a ? "" : " outline"}`}
                        style={{
                          cursor: "pointer",
                          ...(a
                            ? {
                                background: "var(--ink)",
                                color: "var(--paper)",
                              }
                            : null),
                        }}
                      >
                        {lbl}
                      </button>
                    );
                  })}
                </div>
                {range === "custom" && (
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      marginTop: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      className="pf-input"
                      type="date"
                      aria-label="From"
                      style={{ width: 170 }}
                    />
                    <input
                      className="pf-input"
                      type="date"
                      aria-label="To"
                      style={{ width: 170 }}
                    />
                  </div>
                )}
              </div>

              {/* Source */}
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    marginBottom: 8,
                    color: "var(--ink-2)",
                  }}
                >
                  Source
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(
                    [
                      ["all", "All trades", "Synced + manual + imported"],
                      ["manual", "Manual only", "Off-market and CSV imports"],
                    ] as const
                  ).map(([id, lbl, sub]) => {
                    const a = scope === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setScope(id)}
                        style={{
                          flex: "1 1 180px",
                          textAlign: "left",
                          padding: 12,
                          border: "1.5px solid var(--ink)",
                          borderRadius: 9,
                          background: a ? "var(--emerald-bg)" : "var(--paper)",
                          cursor: "pointer",
                          font: "inherit",
                          color: "var(--ink)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {lbl}
                          {a && <Check size={11} color="var(--emerald-text)" />}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--ink-3)",
                            marginTop: 3,
                          }}
                        >
                          {sub}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Columns / sections */}
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    marginBottom: 8,
                    color: "var(--ink-2)",
                  }}
                >
                  Include in export
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(
                    [
                      ["trades", "Trades"],
                      ["notes", "User notes"],
                    ] as const
                  ).map(([k, lbl]) => {
                    const on = includes[k];
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() =>
                          setIncludes((s) => ({ ...s, [k]: !s[k] }))
                        }
                        className={`pf-pill${on ? " emerald" : " outline"}`}
                        style={{ cursor: "pointer" }}
                      >
                        {on && <Check size={11} />} {lbl}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT — summary + action */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            className="pf-card tilt-r"
            style={{ background: "var(--ink)", color: "var(--paper)" }}
          >
            <div className="ttl" style={{ color: "var(--pop-2)" }}>
              WILL EXPORT
            </div>
            <div
              className="mono"
              style={{
                marginTop: 8,
                fontSize: 34,
                fontWeight: 800,
                letterSpacing: -1,
                color: "var(--paper)",
              }}
            >
              {tradeCount != null ? `~${tradeCount} rows` : "Loading…"}
            </div>
            <div
              style={{
                fontFamily: "Instrument Serif, serif",
                fontStyle: "italic",
                fontSize: 15,
                color: "#a09a8d",
                marginTop: 4,
              }}
            >
              {range.toUpperCase()} ·{" "}
              {scope === "all" ? "all sources" : "manual only"} · {sectionsOn}{" "}
              {sectionsOn === 1 ? "section" : "sections"}
            </div>

            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: "var(--on-ink-soft)",
                borderRadius: 8,
                border: "1px solid var(--on-ink-border)",
              }}
            >
              <div
                className="mono"
                style={{ fontSize: 10.5, color: "#a09a8d", letterSpacing: 1 }}
              >
                FILENAME
              </div>
              <div
                className="mono"
                style={{ marginTop: 4, fontSize: 13, color: "var(--paper)" }}
              >
                {fileName}
              </div>
            </div>

            <button
              type="button"
              className="pf-bs"
              data-walkthrough="tradebook-export-action"
              style={{
                marginTop: 16,
                width: "100%",
                justifyContent: "center",
                background: "var(--pop-2)",
                color: "#1d1d1b",
                borderColor: "var(--pop-2)",
              }}
              onClick={handleDownload}
              disabled={busy}
            >
              <Download size={14} /> {busy ? "Preparing…" : "Download"} ·{" "}
              {activeFormat.lbl}
            </button>
          </div>

          <div className="pf-card">
            <div className="ttl">HEADS UP</div>
            <p
              style={{
                marginTop: 8,
                fontSize: 13,
                color: "var(--ink-2)",
                lineHeight: 1.5,
              }}
            >
              Exports run client-side from the latest 100 trades on screen.
              Larger exports trim oldest first.
            </p>
            <p
              style={{
                marginTop: 8,
                fontFamily: "Instrument Serif, serif",
                fontStyle: "italic",
                fontSize: 13.5,
                color: "var(--ink-3)",
              }}
            >
              A full server-side{" "}
              <strong style={{ fontStyle: "normal", color: "var(--ink)" }}>
                ITR-2 schedule
              </strong>{" "}
              (all years) lands in a follow-up — today ITR-2 exports the
              capital-gains columns as CSV.
            </p>
          </div>
        </div>
      </div>
    </TerminalLuxeShell>
  );
}

function filterByRange(trades: TradeRow[], range: RangeId): TradeRow[] {
  if (range === "all" || range === "custom") return trades;
  const now = new Date();
  // MONEY-847: fy/pfy windows derived from `now` (IST FY boundary), not the old
  // hard-coded 2025/2024.
  const currentFY = fyStartYear(now);
  // MONEY-846: route the FY window through the shared IST-anchored helper. The
  // old `new Date(fromDate)` (UTC midnight) + `new Date(`${toDate}T23:59:59.999`)`
  // (no `Z` → LOCAL time) was a 4th divergent FY impl with the same boundary bug:
  // it dropped/mis-bucketed trades in the +5:30 IST sliver and behaved differently
  // on a UTC server vs an IST box.
  const fyWindow =
    currentFY !== null
      ? fyWindowUtc(range === "fy" ? currentFY : currentFY - 1)
      : null;
  return trades.filter((t) => {
    const d = new Date(t.tradeDate);
    if (range === "7d") return (now.getTime() - d.getTime()) / 86_400_000 <= 7;
    if (range === "30d")
      return (now.getTime() - d.getTime()) / 86_400_000 <= 30;
    if ((range === "fy" || range === "pfy") && fyWindow) {
      return d >= fyWindow.gte && d <= fyWindow.lte;
    }
    return true;
  });
}
