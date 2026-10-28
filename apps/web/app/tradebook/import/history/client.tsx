"use client";

import { useState, useEffect, useTransition, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import {
  Upload,
  Check,
  ChevronRight,
  RotateCcw,
  Trash2,
  MoreHorizontal,
  Loader2,
  FileSpreadsheet,
} from "lucide-react";

import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { TradebookSubNav } from "../../lib/sub-nav";
import {
  BrokerLogo,
  toBrokerSlug,
} from "@/components/terminal-luxe/primitives";

import {
  getImportHistoryAction,
  deleteImportBatchAction,
  retryFailedImportAction,
  type ImportBatch,
} from "@/lib/actions/trade-import";
import {
  getActiveImportJobsAction,
  type ImportJobStatus,
} from "@/lib/actions/import-job";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { DemoBanner } from "@/components/DemoBanner";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";

/* =====================================================================
   Demo data - used only when ?demo=true.
   ===================================================================== */
const DEMO_IMPORT_HISTORY: ImportBatch[] = [
  {
    batchId: "demo-batch-1",
    importedAt: new Date("2025-12-15T10:30:00"),
    brokerFormat: "zerodha",
    fileName: "tradebook-zerodha-dec.csv",
    tradeCount: 24,
    importedCount: 24,
    duplicateCount: 0,
    errorCount: 0,
    status: "COMPLETED",
    linkedBroker: "ZERODHA",
    linkedToManual: false,
  },
  {
    batchId: "demo-batch-2",
    importedAt: new Date("2025-11-20T14:15:00"),
    brokerFormat: "upstox",
    fileName: "upstox-nov-trades.xlsx",
    tradeCount: 18,
    importedCount: 15,
    duplicateCount: 3,
    errorCount: 0,
    status: "COMPLETED",
    linkedBroker: "UPSTOX",
    linkedToManual: false,
  },
];

/* Format the relative timestamp shown in the WHEN column. */
function formatWhen(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* `ImportBatch` fields all optional from the action. Normalize at the
   render boundary so we don't sprinkle `?? 0` / `?? ""` everywhere. */
interface NormalizedBatch {
  batchId: string;
  importedAt: Date;
  fileName: string;
  brokerFormat: string;
  linkedBroker: string | null;
  tradeCount: number;
  importedCount: number;
  duplicateCount: number;
  errorCount: number;
  status: string;
}

function normalize(b: ImportBatch): NormalizedBatch {
  return {
    batchId: b.batchId,
    importedAt:
      b.importedAt instanceof Date ? b.importedAt : new Date(b.importedAt),
    fileName: b.fileName ?? "(no filename)",
    brokerFormat: b.brokerFormat ?? "generic",
    linkedBroker: b.linkedBroker ?? null,
    tradeCount: b.tradeCount ?? 0,
    importedCount: b.importedCount ?? 0,
    duplicateCount: b.duplicateCount ?? 0,
    errorCount: b.errorCount ?? 0,
    status: b.status ?? "UNKNOWN",
  };
}

/* Broker accent dots for the playful chips (design palette). */
const BROKER_DOT: Record<string, string> = {
  zerodha: "#387ed1",
  groww: "#5eb66e",
  upstox: "#7b2ff7",
  angel: "#e85454",
  "angel one": "#e85454",
  angelone: "#e85454",
  dhan: "#f59e42",
  fyers: "#2196f3",
  hdfc: "#004c8f",
  "hdfc sky": "#004c8f",
};
function brokerDot(b?: string | null): string {
  return BROKER_DOT[(b ?? "").toLowerCase()] ?? "var(--ink-3)";
}
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ImportHistoryClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const [, startTransition] = useTransition();

  const isDemoMode = useIsDemoMode({ user });
  const demoModeReady = useIsDemoModeReady();

  const [history, setHistory] = useState<NormalizedBatch[]>([]);
  const [activeJobs, setActiveJobs] = useState<ImportJobStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    batchId: string;
    fileName: string;
  }>({ open: false, batchId: "", fileName: "" });
  const [busyBatch, setBusyBatch] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  /* Close per-row menu when clicking outside. */
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openMenu]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      if (isDemoMode && !user) {
        setHistory(DEMO_IMPORT_HISTORY.map(normalize));
        return;
      }
      const result = await getImportHistoryAction();
      if (result?.success) setHistory(result.batches.map(normalize));
    } finally {
      setLoading(false);
    }
  }, [isDemoMode, user]);

  const loadActiveJobs = useCallback(async () => {
    if (isDemoMode && !user) return;
    const result = await getActiveImportJobsAction();
    if (result?.success && result?.jobs) setActiveJobs(result.jobs);
  }, [isDemoMode, user]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) {
      router.push("/home");
      return;
    }
    void loadHistory();
    void loadActiveJobs();
  }, [
    isLoaded,
    demoModeReady,
    user,
    isDemoMode,
    router,
    loadHistory,
    loadActiveJobs,
  ]);

  const handleDelete = (batch: NormalizedBatch) => {
    setConfirmDialog({
      open: true,
      batchId: batch.batchId,
      fileName: batch.fileName,
    });
  };

  const confirmDelete = async () => {
    const { batchId } = confirmDialog;
    setConfirmDialog({ open: false, batchId: "", fileName: "" });
    setBusyBatch(batchId);
    startTransition(async () => {
      try {
        const result = await deleteImportBatchAction(batchId);
        if (result?.success) {
          toast.success("Import deleted");
          await loadHistory();
        } else {
          toast.error(result?.error || "Failed to delete");
        }
      } finally {
        setBusyBatch(null);
      }
    });
  };

  const handleRetry = async (batchId: string) => {
    setBusyBatch(batchId);
    try {
      const result = await retryFailedImportAction(batchId);
      if (result?.success) {
        toast.success("Retry started");
        await loadActiveJobs();
      } else {
        toast.error(result?.error || "Failed to retry");
      }
    } finally {
      setBusyBatch(null);
    }
  };

  /* ── Stats for the summary strip ── */
  const totalImports = history.length;
  const totalRows = history.reduce((s, b) => s + b.importedCount, 0);
  const totalDeduped = history.reduce((s, b) => s + b.duplicateCount, 0);
  const failed = history.filter((b) => b.status !== "COMPLETED").length;

  /* =====================================================================
     Render
     ===================================================================== */

  return (
    <TerminalLuxeShell
      active="tradebook"
      title="Import history"
      breadcrumb="Portfolio · Tradebook"
      onBack={() => router.push("/tradebook")}
    >
      {isDemoMode && <DemoBanner />}

      <PfPageHead
        eyebrow="ROLLBACK-SAFE FOR 24 HOURS"
        title={
          <>
            Every batch <span className="ser">you ever uploaded.</span>
          </>
        }
        sub="Rollback within 24 hours. Each row shows what was imported, deduped, and what failed."
        right={
          <button
            type="button"
            className="pf-bs"
            onClick={() => router.push("/tradebook/import")}
          >
            <Upload style={{ width: 13, height: 13 }} /> New import
          </button>
        }
      />

      <TradebookSubNav active="history" />

      {/* 4-stat strip (design: screens-tradebook-v2 history) */}
      <div
        className="um-stats-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">TOTAL BATCHES</div>
          <div className="v" style={{ fontSize: 22 }}>
            {totalImports}
          </div>
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">ROWS IMPORTED</div>
          <div className="v" style={{ fontSize: 22 }}>
            {totalRows}
          </div>
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">DEDUPED</div>
          <div className="v" style={{ fontSize: 22, color: "var(--ink-3)" }}>
            {totalDeduped}
          </div>
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{
            background: failed > 0 ? "var(--emerald-bg)" : "var(--rule-softer)",
            borderColor: failed > 0 ? "var(--pop-1)" : undefined,
          }}
        >
          <div className="l">FAILED / PARTIAL</div>
          <div
            className="v"
            style={{
              fontSize: 22,
              color: failed > 0 ? "var(--pop-1-text)" : "var(--ink-3)",
            }}
          >
            {failed}
          </div>
        </div>
      </div>

      {/* Active import jobs */}
      {activeJobs.length > 0 && (
        <div
          className="pf-card"
          style={{
            padding: 14,
            marginBottom: 16,
            borderColor: "var(--emerald)",
            background: "var(--emerald-bg)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <Loader2
              style={{
                width: 14,
                height: 14,
                color: "var(--emerald-text)",
                animation: "um-spin 1.2s linear infinite",
              }}
            />
            <span
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                color: "var(--emerald-text)",
              }}
            >
              {activeJobs.length} import{activeJobs.length === 1 ? "" : "s"} in
              progress
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
            Jobs run on the server. You can navigate away - they finish on their
            own and the history below refreshes when they do.
          </div>
        </div>
      )}

      {/* Desktop table — playful (design: pf-tbl) */}
      <div
        className="pf-card um-hide-lt-1100"
        style={{ padding: 0, overflow: "visible" }}
      >
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl" data-walkthrough="tradebook-history-list">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>WHEN</th>
                <th>FILE</th>
                <th>FORMAT</th>
                <th style={{ textAlign: "right" }}>IMPORTED</th>
                <th style={{ textAlign: "right" }}>DEDUPED</th>
                <th style={{ textAlign: "right" }}>FAILED</th>
                <th>STATUS</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      padding: 36,
                      textAlign: "center",
                      color: "var(--ink-3)",
                    }}
                  >
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && history.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      padding: 36,
                      textAlign: "center",
                      color: "var(--ink-3)",
                    }}
                  >
                    No imports yet - head to{" "}
                    <a
                      href="/tradebook/import"
                      style={{
                        color: "var(--emerald-text)",
                        textDecoration: "none",
                      }}
                    >
                      Import
                    </a>{" "}
                    to upload your first tradebook.
                  </td>
                </tr>
              )}
              {history.map((b) => {
                const isBusy = busyBatch === b.batchId;
                return (
                  <tr
                    key={b.batchId}
                    onClick={() =>
                      router.push(`/tradebook/import/log/${b.batchId}`)
                    }
                    style={{ cursor: "pointer" }}
                  >
                    <td className="num" style={{ paddingLeft: 18 }}>
                      {formatWhen(b.importedAt)}
                    </td>
                    <td
                      style={{
                        maxWidth: 220,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: 600,
                        color: "var(--ink)",
                      }}
                    >
                      {b.fileName}
                    </td>
                    <td>
                      {b.brokerFormat === "generic" ? (
                        <span
                          className="br-chip"
                          style={{ padding: "3px 8px", fontSize: 11 }}
                        >
                          <FileSpreadsheet style={{ width: 11, height: 11 }} />{" "}
                          Generic CSV
                        </span>
                      ) : (
                        <span
                          className="br-chip"
                          style={{ padding: "3px 8px", fontSize: 11 }}
                        >
                          <BrokerLogo
                            slug={toBrokerSlug(
                              b.linkedBroker || b.brokerFormat
                            )}
                            size={11}
                          />
                          {titleCase(b.brokerFormat)}
                        </span>
                      )}
                    </td>
                    <td className="num pos" style={{ textAlign: "right" }}>
                      +{b.importedCount}
                    </td>
                    <td
                      className="num"
                      style={{ textAlign: "right", color: "var(--ink-3)" }}
                    >
                      {b.duplicateCount}
                    </td>
                    <td
                      className="num"
                      style={{
                        textAlign: "right",
                        color: b.errorCount
                          ? "var(--pop-1-text)"
                          : "var(--ink-3)",
                      }}
                    >
                      {b.errorCount}
                    </td>
                    <td>
                      {b.status === "COMPLETED" && (
                        <span
                          className="pf-pill emerald"
                          style={{ fontSize: 9.5 }}
                        >
                          <Check size={10} /> OK
                        </span>
                      )}
                      {b.status === "PARTIAL" && (
                        <span
                          className="pf-pill gold"
                          style={{ fontSize: 9.5 }}
                        >
                          PARTIAL
                        </span>
                      )}
                      {b.status === "FAILED" && (
                        <span
                          className="pf-pill coral"
                          style={{ fontSize: 9.5 }}
                        >
                          FAILED
                        </span>
                      )}
                      {b.status !== "COMPLETED" &&
                        b.status !== "PARTIAL" &&
                        b.status !== "FAILED" && (
                          <span
                            className="pf-pill outline"
                            style={{ fontSize: 9.5 }}
                          >
                            {b.status}
                          </span>
                        )}
                    </td>
                    <td
                      onClick={(e) => e.stopPropagation()}
                      style={{ textAlign: "right" }}
                    >
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          position: "relative",
                        }}
                      >
                        <button
                          type="button"
                          aria-label="Open"
                          onClick={() =>
                            router.push(`/tradebook/import/log/${b.batchId}`)
                          }
                          style={{
                            background: "transparent",
                            border: 0,
                            color: "var(--ink-3)",
                            cursor: "pointer",
                            padding: 4,
                          }}
                        >
                          <ChevronRight style={{ width: 14, height: 14 }} />
                        </button>
                        <button
                          type="button"
                          aria-label="More"
                          onClick={() =>
                            setOpenMenu(
                              openMenu === b.batchId ? null : b.batchId
                            )
                          }
                          disabled={isBusy}
                          style={{
                            background: "transparent",
                            border: 0,
                            color: "var(--ink-3)",
                            cursor: "pointer",
                            padding: 4,
                          }}
                        >
                          {isBusy ? (
                            <Loader2
                              style={{
                                width: 14,
                                height: 14,
                                animation: "um-spin .9s linear infinite",
                              }}
                            />
                          ) : (
                            <MoreHorizontal style={{ width: 14, height: 14 }} />
                          )}
                        </button>
                        {openMenu === b.batchId && (
                          <div
                            ref={menuRef}
                            className="pf-card"
                            style={{
                              position: "absolute",
                              top: "calc(100% + 4px)",
                              right: 0,
                              zIndex: 30,
                              minWidth: 180,
                              padding: 6,
                              boxShadow: "var(--shadow-soft)",
                            }}
                          >
                            {b.status !== "COMPLETED" && (
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenMenu(null);
                                  void handleRetry(b.batchId);
                                }}
                                style={menuItemStyle()}
                              >
                                <RotateCcw style={{ width: 13, height: 13 }} />{" "}
                                Retry failed rows
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenu(null);
                                handleDelete(b);
                              }}
                              style={{
                                ...menuItemStyle(),
                                color: "var(--pop-1-text)",
                              }}
                            >
                              <Trash2 style={{ width: 13, height: 13 }} />{" "}
                              Delete batch
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div
        className="um-mobile-only pf-card"
        style={{ flexDirection: "column", padding: 0, display: "none" }}
      >
        {!loading && history.length === 0 && (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            No imports yet.
          </div>
        )}
        {history.map((b) => (
          <div
            key={b.batchId}
            onClick={() => router.push(`/tradebook/import/log/${b.batchId}`)}
            style={{
              padding: 14,
              borderBottom: "1px dashed var(--rule-soft)",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              {b.brokerFormat === "generic" ? (
                <span
                  className="br-chip"
                  style={{ padding: "3px 8px", fontSize: 11 }}
                >
                  <FileSpreadsheet style={{ width: 11, height: 11 }} /> Generic
                  CSV
                </span>
              ) : (
                <span
                  className="br-chip"
                  style={{ padding: "3px 8px", fontSize: 11 }}
                >
                  <BrokerLogo
                    slug={toBrokerSlug(b.linkedBroker || b.brokerFormat)}
                    size={11}
                  />
                  {titleCase(b.brokerFormat)}
                </span>
              )}
              {b.status === "COMPLETED" && (
                <span className="pf-pill emerald" style={{ fontSize: 9.5 }}>
                  <Check size={10} /> OK
                </span>
              )}
              {b.status === "PARTIAL" && (
                <span className="pf-pill gold" style={{ fontSize: 9.5 }}>
                  PARTIAL
                </span>
              )}
              {b.status === "FAILED" && (
                <span className="pf-pill coral" style={{ fontSize: 9.5 }}>
                  FAILED
                </span>
              )}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                marginBottom: 6,
              }}
            >
              {b.fileName}
            </div>
            <div
              className="mono"
              style={{ display: "flex", gap: 12, fontSize: 11 }}
            >
              <span style={{ color: "var(--ink-3)" }}>
                {formatWhen(b.importedAt)}
              </span>
              <span style={{ color: "var(--emerald-text)" }}>
                +{b.importedCount}
              </span>
              {b.duplicateCount > 0 && (
                <span style={{ color: "var(--ink-3)" }}>
                  ~{b.duplicateCount}
                </span>
              )}
              {b.errorCount > 0 && (
                <span style={{ color: "var(--pop-1-text)" }}>
                  ×{b.errorCount}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <ConfirmationDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
        title="Delete this import?"
        description={`Permanently delete the batch from "${confirmDialog.fileName}". Any synced trades stay; only the manual/imported rows tied to this batch are removed.`}
        onConfirm={confirmDelete}
        variant="destructive"
        confirmLabel="Delete"
      />
    </TerminalLuxeShell>
  );
}

function menuItemStyle(): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    background: "transparent",
    border: 0,
    borderRadius: 7,
    color: "var(--ink-2)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "left",
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "JetBrains Mono, monospace",
  };
}
