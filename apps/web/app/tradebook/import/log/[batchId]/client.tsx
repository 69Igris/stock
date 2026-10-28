"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  FileText,
  AlertCircle,
  CheckCircle2,
  Copy,
  XCircle,
  ChevronDown,
} from "lucide-react";
import {
  getImportLogDetailAction,
  type ImportLogDetail,
} from "@/lib/actions/trade-import";
import Sidebar from "@/components/Sidebar";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { useUser } from "@clerk/nextjs";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";

// ============== DEMO DATA ==============

const DEMO_LOG_DETAILS: Record<string, ImportLogDetail> = {
  "demo-batch-1": {
    batchId: "demo-batch-1",
    status: "COMPLETED",
    brokerFormat: "zerodha",
    fileName: "tradebook-zerodha-dec.csv",
    fileSize: 45000,
    totalRows: 24,
    importedCount: 24,
    skippedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    linkedBroker: "ZERODHA",
    linkedBrokerUserId: "AB1234",
    linkedToManual: false,
    createdAt: new Date("2025-12-15T10:30:00"),
    completedAt: new Date("2025-12-15T10:30:12"),
    duplicateDetails: [],
    errorDetails: [],
  },
  "demo-batch-2": {
    batchId: "demo-batch-2",
    status: "COMPLETED",
    brokerFormat: "upstox",
    fileName: "upstox-nov-trades.xlsx",
    fileSize: 82000,
    totalRows: 18,
    importedCount: 15,
    skippedCount: 3,
    duplicateCount: 3,
    errorCount: 0,
    linkedBroker: "UPSTOX",
    linkedBrokerUserId: null,
    linkedToManual: false,
    createdAt: new Date("2025-11-20T14:15:00"),
    completedAt: new Date("2025-11-20T14:15:08"),
    duplicateDetails: [
      {
        tradeHash: "d1",
        rowNumber: 5,
        reason: "Exact match with synced trade",
        existingSourceType: "SYNCED",
        existingBroker: "UPSTOX",
      },
      {
        tradeHash: "d2",
        rowNumber: 11,
        reason: "Exact match with synced trade",
        existingSourceType: "SYNCED",
        existingBroker: "UPSTOX",
      },
      {
        tradeHash: "d3",
        rowNumber: 16,
        reason: "Exact match with synced trade",
        existingSourceType: "SYNCED",
        existingBroker: "UPSTOX",
      },
    ],
    errorDetails: [],
  },
  "demo-batch-3": {
    batchId: "demo-batch-3",
    status: "COMPLETED",
    brokerFormat: "generic",
    fileName: "my-trades-oct.csv",
    fileSize: 12000,
    totalRows: 8,
    importedCount: 8,
    skippedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    linkedBroker: null,
    linkedBrokerUserId: null,
    linkedToManual: true,
    createdAt: new Date("2025-10-05T09:00:00"),
    completedAt: new Date("2025-10-05T09:00:05"),
    duplicateDetails: [],
    errorDetails: [],
  },
};

interface ImportLogDetailClientProps {
  batchId: string;
}

function getStatusBadge(status: string) {
  switch (status) {
    case "COMPLETED":
      return (
        <span className="pf-pill emerald" style={{ fontSize: 10 }}>
          <CheckCircle2 style={{ width: 11, height: 11 }} /> Completed
        </span>
      );
    case "FAILED":
      return (
        <span className="pf-pill coral" style={{ fontSize: 10 }}>
          <XCircle style={{ width: 11, height: 11 }} /> Failed
        </span>
      );
    case "PARTIALLY_COMPLETED":
      return (
        <span className="pf-pill gold" style={{ fontSize: 10 }}>
          <AlertCircle style={{ width: 11, height: 11 }} /> Partial
        </span>
      );
    case "DELETED":
      return (
        <span className="pf-pill outline" style={{ fontSize: 10 }}>
          Deleted
        </span>
      );
    default:
      return (
        <span className="pf-pill outline" style={{ fontSize: 10 }}>
          {status}
        </span>
      );
  }
}

/** Collapsible detail section (duplicates / errors) */
function DetailAccordion({
  title,
  count,
  accent,
  icon: Icon,
  children,
}: {
  title: string;
  count: number;
  accent: string;
  icon: React.ComponentType<{ style?: React.CSSProperties }>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: "14px 18px",
          background: "transparent",
          border: 0,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 10,
          textAlign: "left",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <Icon style={{ width: 15, height: 15, color: accent }} />
        <span
          style={{
            fontWeight: 700,
            fontSize: 14,
            color: "var(--ink)",
            flex: 1,
          }}
        >
          {title}{" "}
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600 }}
          >
            ({count})
          </span>
        </span>
        <ChevronDown
          style={{
            width: 14,
            height: 14,
            color: "var(--ink-3)",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform .15s",
          }}
        />
      </button>
      {open && (
        <div style={{ borderTop: "1px dashed var(--rule-soft)", padding: 0 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export default function ImportLogDetailClient({
  batchId,
}: ImportLogDetailClientProps) {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isDemoMode = useIsDemoMode({ user });
  const demoModeReady = useIsDemoModeReady();
  const [log, setLog] = useState<ImportLogDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) {
      router.push("/home");
      return;
    }
    if (isDemoMode && !user) {
      const demoLog = DEMO_LOG_DETAILS[batchId];
      if (demoLog) {
        setLog(demoLog);
      } else {
        setError("Demo import log not found");
      }
      setLoading(false);
      return;
    }
    async function fetchLog() {
      setLoading(true);
      const result = await getImportLogDetailAction(batchId);
      if (result?.success && result?.log) {
        setLog(result?.log);
      } else {
        setError(result?.error || "Failed to load import log");
      }
      setLoading(false);
    }
    fetchLog();
  }, [batchId, isLoaded, demoModeReady, user, isDemoMode, router]);

  const formatDate = (date: Date | string | null) => {
    if (!date) return "—";
    return new Date(date).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (loading) {
    return (
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="px-4 sm:px-6 py-6 max-w-[1600px] mx-auto">
            <div
              style={{
                padding: 48,
                textAlign: "center",
                color: "var(--ink-3)",
              }}
              className="serif"
            >
              Loading import details…
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (error || !log) {
    return (
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="px-4 sm:px-6 py-6 max-w-[1600px] mx-auto">
            <div
              className="pf-card"
              style={{ padding: 32, textAlign: "center" }}
            >
              <AlertCircle
                style={{
                  width: 40,
                  height: 40,
                  color: "var(--pop-1)",
                  margin: "0 auto 12px",
                }}
              />
              <h2
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: "var(--ink)",
                  marginBottom: 6,
                }}
              >
                Import Log Not Found
              </h2>
              <p
                style={{
                  fontFamily: "Instrument Serif, serif",
                  fontStyle: "italic",
                  color: "var(--ink-3)",
                  marginBottom: 16,
                  fontSize: 15,
                }}
              >
                {error || "The requested import log could not be found."}
              </p>
              <Link
                href="/tradebook/import/history"
                style={{ textDecoration: "none" }}
              >
                <button type="button" className="pf-bf sm">
                  <ArrowLeft style={{ width: 13, height: 13 }} />
                  Back to History
                </button>
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1600px] mx-auto">
          {/* Playful page header */}
          <PfPageHead
            eyebrow="IMPORT LOG"
            title={
              <>
                Batch{" "}
                <span className="mono" style={{ fontSize: "0.7em" }}>
                  {batchId.slice(0, 12)}
                </span>
              </>
            }
            sub="Row-by-row breakdown of this import — duplicates, errors, and what landed."
            right={
              <>
                {getStatusBadge(log.status)}
                <Link
                  href="/tradebook/import/history"
                  style={{ textDecoration: "none" }}
                >
                  <button type="button" className="pf-bf sm">
                    <ArrowLeft style={{ width: 13, height: 13 }} />
                    Import history
                  </button>
                </Link>
              </>
            }
          />

          {/* Summary card */}
          <div
            className="pf-card"
            style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}
          >
            <div
              style={{
                padding: "16px 22px",
                borderBottom: "1.5px dashed var(--rule-soft)",
              }}
            >
              <div className="ttl">IMPORT SUMMARY</div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 15,
                  fontFamily: "Instrument Serif, serif",
                  fontStyle: "italic",
                  color: "var(--ink-3)",
                }}
              >
                {log.fileName || "Uploaded file"} — {formatDate(log.createdAt)}
              </div>
            </div>
            <div style={{ padding: 18 }}>
              {/* Stats */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div
                  className="pf-card pf-stat flat"
                  style={{ background: "var(--rule-softer)" }}
                >
                  <div className="l">TOTAL ROWS</div>
                  <div className="v" style={{ fontSize: 22 }}>
                    {log.totalRows}
                  </div>
                </div>
                <div
                  className="pf-card pf-stat flat"
                  style={{
                    background: "var(--emerald-bg)",
                    borderColor: "var(--emerald)",
                  }}
                >
                  <div className="l">IMPORTED</div>
                  <div
                    className="v"
                    style={{ fontSize: 22, color: "var(--emerald-text)" }}
                  >
                    {log.importedCount}
                  </div>
                </div>
                <div
                  className="pf-card pf-stat flat"
                  style={{ background: "var(--rule-softer)" }}
                >
                  <div className="l">DUPLICATES</div>
                  <div
                    className="v"
                    style={{ fontSize: 22, color: "var(--pop-2-text)" }}
                  >
                    {log.duplicateCount}
                  </div>
                </div>
                <div
                  className="pf-card pf-stat flat"
                  style={{ background: "var(--rule-softer)" }}
                >
                  <div className="l">ERRORS</div>
                  <div
                    className="v"
                    style={{
                      fontSize: 22,
                      color: log.errorCount
                        ? "var(--pop-1-text)"
                        : "var(--ink-3)",
                    }}
                  >
                    {log.errorCount}
                  </div>
                </div>
              </div>

              {/* Meta grid */}
              <div
                style={{
                  paddingTop: 16,
                  borderTop: "1.5px dashed var(--rule-soft)",
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: 10,
                  fontSize: 13,
                }}
              >
                {[
                  ["Format", log.brokerFormat],
                  ["File Size", formatFileSize(log.fileSize)],
                  [
                    "Linked To",
                    log.linkedToManual
                      ? "Manual Account"
                      : log.linkedBroker
                        ? `${log.linkedBroker}${log.linkedBrokerUserId ? ` (${log.linkedBrokerUserId})` : ""}`
                        : "None",
                  ],
                  ["Completed", formatDate(log.completedAt)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <span style={{ color: "var(--ink-3)" }}>{k}:</span>{" "}
                    <span
                      className="mono"
                      style={{
                        color: "var(--ink)",
                        fontWeight: 700,
                        textTransform: "capitalize",
                      }}
                    >
                      {v}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Duplicate Details */}
          {log.duplicateDetails && log.duplicateDetails.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <DetailAccordion
                title="Duplicate Details"
                count={log.duplicateDetails.length}
                accent="var(--pop-2-text)"
                icon={Copy}
              >
                {/* Scrolls horizontally if needed */}
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 12,
                      minWidth: 480,
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: "var(--rule-softer)",
                          borderBottom: "1.5px solid var(--ink)",
                        }}
                      >
                        {["ROW", "REASON", "SOURCE TYPE", "BROKER"].map((h) => (
                          <th
                            key={h}
                            style={{
                              padding: "8px 14px",
                              textAlign: "left",
                              fontWeight: 700,
                              letterSpacing: 1,
                              fontSize: 10,
                              color: "var(--ink-3)",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {log.duplicateDetails.map((dup, i) => (
                        <tr
                          key={i}
                          style={{
                            borderBottom: "1px dashed var(--rule-soft)",
                          }}
                        >
                          <td
                            style={{
                              padding: "8px 14px",
                              color: "var(--ink-3)",
                            }}
                          >
                            {dup.rowNumber}
                          </td>
                          <td
                            style={{
                              padding: "8px 14px",
                              color: "var(--pop-2-text)",
                              fontWeight: 600,
                            }}
                          >
                            {dup.reason}
                          </td>
                          <td style={{ padding: "8px 14px" }}>
                            <span
                              className="pf-pill outline"
                              style={{ fontSize: 9.5 }}
                            >
                              {dup.existingSourceType}
                            </span>
                          </td>
                          <td
                            style={{
                              padding: "8px 14px",
                              color: "var(--ink-2)",
                            }}
                          >
                            {dup.existingBroker || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DetailAccordion>
            </div>
          )}

          {/* Error Details */}
          {log.errorDetails && log.errorDetails.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <DetailAccordion
                title="Error Details"
                count={log.errorDetails.length}
                accent="var(--pop-1-text)"
                icon={AlertCircle}
              >
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 12,
                      minWidth: 320,
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: "var(--rule-softer)",
                          borderBottom: "1.5px solid var(--ink)",
                        }}
                      >
                        {["ROW", "ERROR"].map((h) => (
                          <th
                            key={h}
                            style={{
                              padding: "8px 14px",
                              textAlign: "left",
                              fontWeight: 700,
                              letterSpacing: 1,
                              fontSize: 10,
                              color: "var(--ink-3)",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {log.errorDetails.map((err, i) => (
                        <tr
                          key={i}
                          style={{
                            borderBottom: "1px dashed var(--rule-soft)",
                          }}
                        >
                          <td
                            style={{
                              padding: "8px 14px",
                              color: "var(--ink-3)",
                            }}
                          >
                            {err.row}
                          </td>
                          <td
                            style={{
                              padding: "8px 14px",
                              color: "var(--pop-1-text)",
                              fontWeight: 600,
                            }}
                          >
                            {err.error}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DetailAccordion>
            </div>
          )}

          {/* Clean import state */}
          {(!log.duplicateDetails || log.duplicateDetails.length === 0) &&
            (!log.errorDetails || log.errorDetails.length === 0) && (
              <div
                className="pf-card"
                style={{ padding: 28, textAlign: "center" }}
              >
                <CheckCircle2
                  style={{
                    width: 40,
                    height: 40,
                    color: "var(--emerald)",
                    margin: "0 auto 12px",
                  }}
                />
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    color: "var(--ink)",
                    marginBottom: 4,
                  }}
                >
                  Clean import.
                </h3>
                <p
                  style={{
                    fontFamily: "Instrument Serif, serif",
                    fontStyle: "italic",
                    fontSize: 15,
                    color: "var(--ink-3)",
                  }}
                >
                  All rows imported successfully — no duplicates, no errors.
                </p>
              </div>
            )}
        </div>
      </main>
    </div>
  );
}
