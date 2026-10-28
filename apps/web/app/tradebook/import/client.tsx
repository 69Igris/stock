"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import {
  History,
  Plus,
  UploadCloud,
  Sparkles,
  Info,
  FileSpreadsheet,
  File as FileIcon,
  Check,
  AlertTriangle,
} from "lucide-react";
import Image from "next/image";

import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { TradebookSubNav } from "../lib/sub-nav";

import {
  previewCSVAction,
  getImportHistoryAction,
  type BrokerFormat,
  type PreviewRow,
  type ImportBatch,
} from "@/lib/actions/trade-import";
import { getBrokerConnectionsAction } from "@/lib/actions/broker-connection";
import {
  startImportJobAction,
  getActiveImportJobsAction,
  type ImportJobStatus,
} from "@/lib/actions/import-job";
import ImportProgress from "@/components/import/ImportProgress";
import type { BrokerType } from "@prisma/client";
import { DemoBanner } from "@/components/DemoBanner";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";

/* =====================================================================
   Demo data - used only when ?demo=true to give logged-out visitors a
   feel for the import flow without hitting any server actions.
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
];

/* =====================================================================
   Broker catalog for the format-pills row
   ===================================================================== */

interface BrokerOption {
  value: BrokerFormat;
  label: string;
  /** Slug used to load the asset from /public/brokers/. */
  slug: string;
}

/* `BrokerFormat` covers the parser-supported list. HDFC / ICICI imports
   route through the generic CSV adapter for now since those brokers don't
   have a dedicated parser. */
const BROKER_OPTIONS: BrokerOption[] = [
  { value: "zerodha", label: "Zerodha", slug: "zerodha" },
  { value: "upstox", label: "Upstox", slug: "upstox" },
  { value: "dhan", label: "Dhan", slug: "dhan" },
  { value: "fyers", label: "Fyers", slug: "fyers" },
  { value: "angel", label: "Angel", slug: "angel" },
  { value: "groww", label: "Groww", slug: "groww" },
];

interface BrokerConnection {
  id: string;
  broker: BrokerType;
  brokerUserId: string | null;
  accountName: string | null;
  status: string;
}

/* =====================================================================
   Step state machine
   ===================================================================== */

type StepId = 1 | 2 | 3 | 4;

interface Step {
  id: StepId;
  label: string;
}

const STEPS: Step[] = [
  { id: 1, label: "Upload" },
  { id: 2, label: "Map columns" },
  { id: 3, label: "Review" },
  { id: 4, label: "Done" },
];

/* =====================================================================
   Sub-nav (Trades · Import · History · Export) is now the shared
   `TradebookSubNav` from `../lib/sub-nav` — used by ALL four tradebook
   pages so a future tab change is one edit instead of four. The previous
   local copy here keyed off `pf-tabs` / `pf-tab` classes that don't
   exist in playful-app.css, so the strip rendered as unstyled native
   inline elements (stacked vertical, no pill background).
   ===================================================================== */

/* =====================================================================
   Stepper bar — wraps on mobile, horizontal on desktop
   ===================================================================== */

function Stepper({ current }: { current: StepId }) {
  return (
    <div
      className="pf-card flat"
      style={{
        display: "flex",
        alignItems: "center",
        marginBottom: 18,
        padding: "10px 12px",
        background: "var(--rule-softer)",
        overflowX: "auto",
        flexWrap: "nowrap",
        gap: 0,
      }}
    >
      {STEPS.map((s, i) => {
        const active = current === s.id;
        const done = current > s.id;
        return (
          <span key={s.id} style={{ display: "contents" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexShrink: 0,
                padding: "8px 12px",
                borderRadius: 9,
                background: active
                  ? "var(--ink)"
                  : done
                    ? "var(--emerald-bg)"
                    : "transparent",
                color: active
                  ? "var(--paper)"
                  : done
                    ? "var(--emerald-text)"
                    : "var(--ink-3)",
              }}
            >
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: done
                    ? "var(--emerald)"
                    : active
                      ? "var(--paper)"
                      : "var(--rule-softer)",
                  color: done ? "#fff" : active ? "var(--ink)" : "var(--ink-3)",
                  border: "1.5px solid",
                  borderColor: active || done ? "currentColor" : "var(--ink)",
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                {done ? <Check style={{ width: 12, height: 12 }} /> : s.id}
              </div>
              <div>
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    letterSpacing: 1,
                    fontWeight: 800,
                    opacity: 0.65,
                  }}
                >
                  STEP {s.id}
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 12.5,
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.label}
                </div>
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div
                style={{
                  width: 20,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--ink-3)",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
}

/* =====================================================================
   Page
   ===================================================================== */

export default function TradeImportClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isDemoMode = useIsDemoMode({ user });
  const demoModeReady = useIsDemoModeReady();

  /* ── State machine ── */
  const [step, setStep] = useState<StepId>(1);

  /* ── File state ── */
  const [file, setFile] = useState<File | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [fileType, setFileType] = useState<"csv" | "xlsx">("csv");
  // Auto-detect is the default (the upload copy already promises it): the
  // preview action inspects the header row and reports the real broker, so a
  // user need not know their broker's format up front. `generic` is the
  // auto-detect sentinel the preview action keys on. (MONEY-1074)
  const [brokerFormat, setBrokerFormat] = useState<BrokerFormat>("generic");
  const [autoDetect, setAutoDetect] = useState(true);
  // Broker format the preview actually parsed with, + its label, for the badge
  // and for starting the import job with the correct mapping.
  const [detectedFormat, setDetectedFormat] = useState<BrokerFormat | null>(
    null
  );
  const [detectedLabel, setDetectedLabel] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ── Broker connection linking ── */
  const [brokerConnections, setBrokerConnections] = useState<
    BrokerConnection[]
  >([]);
  const [selectedConnection, setSelectedConnection] = useState<string>("none");

  /* ── Preview ── */
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewStats, setPreviewStats] = useState<{
    totalRows: number;
    validRows: number;
    invalidRows: number;
    columns: string[];
  } | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  /* ── Import job ── */
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
    duplicateSynced: number;
    errors: string[];
    batchId: string;
  } | null>(null);

  /* ── Bootstrap ── */
  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) {
      router.push("/home");
      return;
    }
    if (isDemoMode && !user) {
      // Demo: skip backend calls but still let the user click through.
      return;
    }
    void getBrokerConnectionsAction().then((result) => {
      if (result?.success && result?.data) {
        setBrokerConnections(
          // MONEY-837: exclude the founder-only Connect app (it never has data).
          result.data.filter(
            (c) => c.status === "CONNECTED" && c.broker !== "ZERODHA_CONNECT"
          ) as BrokerConnection[]
        );
      }
    });
    void getActiveImportJobsAction().then((result) => {
      if (result?.success && result?.jobs && result.jobs.length > 0) {
        setActiveJobId(result.jobs[0].jobId);
      }
    });
  }, [isLoaded, demoModeReady, user, isDemoMode, router]);

  /* ── File handling ── */

  const acceptFile = useCallback((selectedFile: File) => {
    const isCSV = selectedFile.name.toLowerCase().endsWith(".csv");
    const isXLSX =
      selectedFile.name.toLowerCase().endsWith(".xlsx") ||
      selectedFile.name.toLowerCase().endsWith(".xls");
    if (!isCSV && !isXLSX) {
      toast.error("Please upload a CSV or Excel (.xlsx) file");
      return;
    }
    const maxSize = isXLSX ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (selectedFile.size > maxSize) {
      toast.error(`File size must be less than ${isXLSX ? "10MB" : "5MB"}`);
      return;
    }
    setFile(selectedFile);
    setFileType(isXLSX ? "xlsx" : "csv");
    setImportResult(null);
    setPreviewRows([]);
    setPreviewStats(null);
    setPreviewErrors([]);

    const reader = new FileReader();
    reader.onload = (event) => {
      if (isXLSX) {
        const arrayBuffer = event.target?.result as ArrayBuffer;
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        setFileContent(btoa(binary));
      } else {
        setFileContent(event.target?.result as string);
      }
    };
    if (isXLSX) reader.readAsArrayBuffer(selectedFile);
    else reader.readAsText(selectedFile);

    /* Auto-advance to step 2 after a short pause so the user sees the
       file land. The preview kicks off in step 2. */
    setTimeout(() => setStep(2), 400);
  }, []);

  /* ── Preview (step 2 → step 3 transition) ── */

  const runPreview = useCallback(async () => {
    if (!fileContent || isDemoMode) {
      setStep(3);
      return;
    }
    setIsPreviewing(true);
    setPreviewErrors([]);
    try {
      const result = await previewCSVAction(
        fileContent,
        brokerFormat,
        fileType
      );
      if (result?.success) {
        setPreviewRows(result.rows);
        setPreviewStats({
          totalRows: result.totalRows,
          validRows: result.validRows,
          invalidRows: result.invalidRows,
          columns: result.columns,
        });
        setDetectedFormat(result.detectedFormat ?? null);
        setDetectedLabel(result.detectedLabel ?? null);
        // Default-select all valid rows. PreviewRow.error is set when
        // parsing fails on that row; rows without it are eligible.
        const all = new Set<number>();
        result.rows.forEach((r, i) => {
          if (!r.error) all.add(i);
        });
        setSelectedRows(all);
      } else {
        setDetectedFormat(null);
        setDetectedLabel(null);
        setPreviewErrors(result?.errors ?? ["Failed to parse file"]);
      }
    } catch (err) {
      setPreviewErrors([
        err instanceof Error && err.message
          ? err.message
          : "Failed to preview file. Please check the file and try again.",
      ]);
    } finally {
      setIsPreviewing(false);
    }
  }, [fileContent, brokerFormat, fileType, isDemoMode]);

  /* ── Import (step 3 → step 4) ── */

  const runImport = useCallback(async () => {
    if (!fileContent || isDemoMode) {
      setImportResult({
        imported: previewStats?.validRows ?? 0,
        skipped: 0,
        duplicateSynced: 0,
        errors: [],
        batchId: "demo",
      });
      setStep(4);
      return;
    }
    try {
      // Start the worker with the format the preview actually parsed (the
      // auto-detected broker), so the worker's mapping matches the preview.
      // Falls back to the selected/sentinel format when detection didn't run.
      const importFormat =
        autoDetect && detectedFormat ? detectedFormat : brokerFormat;
      const result = await startImportJobAction({
        content: fileContent,
        brokerFormat: importFormat,
        fileType,
        fileName: file?.name,
        fileSize: file?.size,
        brokerConnectionId:
          selectedConnection !== "none" && selectedConnection !== "manual"
            ? selectedConnection
            : undefined,
        linkToManual: selectedConnection === "manual",
      });
      if (result?.success && result.jobId) {
        setActiveJobId(result.jobId);
        toast.success("Import started");
        setStep(4);
      } else {
        toast.error(result?.error || "Failed to start import");
      }
    } catch {
      toast.error("Failed to start import");
    }
  }, [
    fileContent,
    brokerFormat,
    autoDetect,
    detectedFormat,
    fileType,
    file,
    selectedConnection,
    isDemoMode,
    previewStats,
  ]);

  const handleJobComplete = useCallback((job: ImportJobStatus) => {
    if (job.result) {
      setImportResult({
        imported: job.result.imported || 0,
        skipped: job.result.skipped || 0,
        duplicateSynced: job.result.duplicates?.synced || 0,
        errors: job.result?.errors || [],
        batchId: job.result.batchId || "",
      });
    }
    setActiveJobId(null);
  }, []);

  /* Auto-run preview when reaching step 2. Uses a ref so we don't refetch
     when other deps change while the user is on the same step. */
  const previewedRef = useRef(false);
  useEffect(() => {
    if (step === 2 && !previewedRef.current && fileContent) {
      previewedRef.current = true;
      void runPreview();
    }
    if (step !== 2) previewedRef.current = false;
  }, [step, fileContent, runPreview]);

  /* ── Step 3 row toggle ── */
  const toggleRow = (idx: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  /* ── Step 4 stats ──
     Duplicates are computed server-side at import time, not at preview
     time - `PreviewRow` doesn't carry that flag. The Step 3 review column
     surfaces only "New" vs "Error" rows; the import job's response feeds
     the final duplicate count back into `importResult` for Step 4. */
  const selectedCount = selectedRows.size;

  /* =====================================================================
     Render
     ===================================================================== */

  return (
    <TerminalLuxeShell
      active="tradebook"
      title="Import trades"
      breadcrumb="Portfolio · Tradebook"
      onBack={() => router.push("/tradebook")}
    >
      {isDemoMode && <DemoBanner />}

      <PfPageHead
        eyebrow="14+ BROKER FORMATS · DRAG & DROP"
        title={
          <>
            Import a <span className="hl">CSV</span>,{" "}
            <span className="ser">we&apos;ll do the rest.</span>
          </>
        }
        sub="Drop a Zerodha P&L, Groww tax report, Upstox tradebook, or a generic CSV. We auto-detect columns and dedupe against your existing rows."
      />

      <TradebookSubNav active="import" />

      <Stepper current={step} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 300px",
          gap: 16,
        }}
        className="um-import-grid"
      >
        {/* ───────── MAIN COLUMN ───────── */}
        <div className="pf-card" style={{ padding: 22 }}>
          {step === 1 && (
            <Step1Upload
              dragOver={dragOver}
              setDragOver={setDragOver}
              file={file}
              brokerFormat={brokerFormat}
              setBrokerFormat={setBrokerFormat}
              autoDetect={autoDetect}
              setAutoDetect={setAutoDetect}
              inputRef={inputRef}
              acceptFile={acceptFile}
            />
          )}

          {step === 2 && (
            <Step2Map
              isPreviewing={isPreviewing}
              previewStats={previewStats}
              previewRows={previewRows}
              previewErrors={previewErrors}
              formatLabel={
                autoDetect
                  ? (detectedLabel ?? "auto-detected")
                  : (BROKER_OPTIONS.find((b) => b.value === brokerFormat)
                      ?.label ?? brokerFormat)
              }
              onBack={() => setStep(1)}
              onContinue={() => setStep(3)}
            />
          )}

          {step === 3 && (
            <Step3Review
              previewRows={previewRows}
              previewStats={previewStats}
              selectedRows={selectedRows}
              toggleRow={toggleRow}
              brokerConnections={brokerConnections}
              selectedConnection={selectedConnection}
              setSelectedConnection={setSelectedConnection}
              onBack={() => setStep(2)}
              onImport={runImport}
            />
          )}

          {step === 4 && (
            <Step4Done
              imported={importResult?.imported ?? selectedCount}
              skipped={importResult?.skipped ?? 0}
              duplicateSynced={importResult?.duplicateSynced ?? 0}
              activeJobId={activeJobId}
              onComplete={handleJobComplete}
              onBackToList={() => router.push("/tradebook")}
              onViewHistory={() => router.push("/tradebook/import/history")}
            />
          )}
        </div>

        {/* ───────── RIGHT SIDE PANEL ───────── */}
        <div className="um-import-side">
          {/* Detected file card */}
          <div className="pf-card" style={{ padding: 16, marginBottom: 12 }}>
            <div className="ttl" style={{ marginBottom: 10 }}>
              DETECTED FILE
            </div>
            {file ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 12,
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 48,
                      background: "var(--pop-2)",
                      border: "1.5px solid var(--ink)",
                      borderRadius: 6,
                      display: "grid",
                      placeItems: "center",
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 9,
                      fontWeight: 800,
                      color: "#1d1d1b",
                      transform: "rotate(-3deg)",
                      flexShrink: 0,
                    }}
                  >
                    {fileType.toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "var(--ink)",
                      }}
                    >
                      {file.name}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: "var(--ink-3)",
                        marginTop: 2,
                      }}
                    >
                      {(file.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                </div>
                {/* Broker auto-detect badge */}
                <div
                  style={{
                    padding: "8px 12px",
                    background: "var(--emerald-bg)",
                    border: "1.5px solid var(--emerald)",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--emerald-text)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 10,
                  }}
                >
                  <Check style={{ width: 12, height: 12 }} />
                  Detected as{" "}
                  <strong>
                    {autoDetect
                      ? (detectedLabel ?? "Auto-detecting…")
                      : (BROKER_OPTIONS.find((b) => b.value === brokerFormat)
                          ?.label ?? brokerFormat)}
                  </strong>
                </div>
                <dl style={{ margin: 0 }}>
                  {(
                    [
                      [
                        "Rows",
                        previewStats ? String(previewStats.totalRows) : "—",
                      ],
                      [
                        "Valid",
                        previewStats ? String(previewStats.validRows) : "—",
                      ],
                      [
                        "Errors",
                        previewStats ? String(previewStats.invalidRows) : "—",
                      ],
                    ] as const
                  ).map(([k, v]) => (
                    <div
                      key={k}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "5px 0",
                        borderBottom: "1px dashed var(--rule-soft)",
                        fontSize: 12,
                      }}
                    >
                      <dt style={{ color: "var(--ink-3)" }}>{k}</dt>
                      <dd
                        className="mono"
                        style={{
                          margin: 0,
                          color: "var(--ink-2)",
                          fontWeight: 700,
                        }}
                      >
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <div
                style={{
                  padding: "20px 12px",
                  textAlign: "center",
                  color: "var(--ink-3)",
                  fontSize: 12.5,
                }}
              >
                <FileIcon
                  style={{
                    width: 24,
                    height: 24,
                    margin: "0 auto 8px",
                    color: "var(--ink-4)",
                  }}
                />
                <div>No file selected yet.</div>
              </div>
            )}
          </div>

          {/* What we need card (tilted gold) */}
          <div
            className="pf-card tilt-r"
            style={{
              background: "var(--pop-2)",
              color: "#1d1d1b",
              marginBottom: 12,
            }}
          >
            <div className="ttl" style={{ color: "#1d1d1b", opacity: 0.65 }}>
              WHAT WE NEED
            </div>
            <ul
              style={{
                margin: "10px 0 0",
                paddingLeft: 18,
                fontSize: 12.5,
                color: "#3a3a35",
                lineHeight: 1.7,
              }}
            >
              {[
                "Symbol, side, qty, price, date",
                "Optional: charges, broker, segment",
                "UTF-8 encoded · header row required",
                "Duplicates flagged on timestamp + ticker + qty",
                "Rollback any import within 24h",
              ].map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
            <a
              href="/tradebook-template.csv"
              download="usemoney-tradebook-template.csv"
              style={{
                display: "inline-flex",
                marginTop: 12,
                padding: "5px 10px",
                borderRadius: 6,
                background: "var(--ink)",
                color: "var(--paper)",
                fontWeight: 700,
                fontSize: 11.5,
                textDecoration: "none",
              }}
            >
              Download template →
            </a>
          </div>

          {/* Supported brokers */}
          <div className="pf-card" style={{ padding: 16, marginBottom: 12 }}>
            <div className="ttl" style={{ marginBottom: 10 }}>
              SUPPORTED BROKERS
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {BROKER_OPTIONS.map((b) => (
                <Image
                  key={b.slug}
                  src={`/brokers/${b.slug}.png`}
                  alt={b.label}
                  width={28}
                  height={28}
                  style={{
                    borderRadius: 6,
                    border: "1.5px solid var(--rule-soft)",
                  }}
                />
              ))}
            </div>
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 10 }}
            >
              · all formats supported · 1-click reconcile
            </div>
          </div>

          <a
            href="/tradebook/import/history"
            data-walkthrough="tradebook-import-history"
            className="pf-bf sm"
            style={{
              width: "100%",
              justifyContent: "center",
              textDecoration: "none",
            }}
          >
            <History style={{ width: 13, height: 13 }} /> View all · import
            history
          </a>
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .um-import-grid { grid-template-columns: 1fr !important; }
          .um-import-side { order: -1; }
        }
        .pf-tabs { flex-wrap: wrap; }
      `}</style>
    </TerminalLuxeShell>
  );
}

/* =====================================================================
   STEP 1 - Upload + broker pills
   ===================================================================== */

function Step1Upload({
  dragOver,
  setDragOver,
  file,
  brokerFormat,
  setBrokerFormat,
  autoDetect,
  setAutoDetect,
  inputRef,
  acceptFile,
}: {
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  file: File | null;
  brokerFormat: BrokerFormat;
  setBrokerFormat: (v: BrokerFormat) => void;
  autoDetect: boolean;
  setAutoDetect: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  acceptFile: (f: File) => void;
}) {
  return (
    <>
      <div className="ttl" style={{ marginBottom: 10 }}>
        STEP 1 · UPLOAD FILE
      </div>
      <h3
        style={{
          margin: "0 0 4px",
          fontSize: 19,
          fontWeight: 800,
          letterSpacing: -0.4,
          color: "var(--ink)",
        }}
      >
        Drop your tradebook CSV or Excel.
      </h3>
      <p
        style={{
          margin: "0 0 18px",
          fontFamily: "Instrument Serif, serif",
          fontStyle: "italic",
          color: "var(--ink-3)",
          fontSize: 15,
        }}
      >
        Supports exports from Zerodha Kite, Upstox, Dhan, Fyers, Angel One,
        Groww. We&apos;ll auto-detect the broker format.
      </p>

      <div style={{ marginBottom: 14 }}>
        <div className="ttl" style={{ display: "block", marginBottom: 8 }}>
          SELECT BROKER (OPTIONAL)
        </div>
        <div
          data-walkthrough="tradebook-import-broker"
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          {BROKER_OPTIONS.map((b) => {
            const a = !autoDetect && brokerFormat === b.value;
            return (
              <button
                key={b.value}
                type="button"
                onClick={() => {
                  setAutoDetect(false);
                  setBrokerFormat(b.value);
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: a ? "var(--ink)" : "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  color: a ? "var(--paper)" : "var(--ink-2)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  transition: "all .12s",
                }}
              >
                <Image
                  src={`/brokers/${b.slug}.png`}
                  alt={b.label}
                  width={14}
                  height={14}
                  style={{ borderRadius: 3 }}
                />
                {b.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setAutoDetect(true);
              setBrokerFormat("generic");
            }}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              background: autoDetect ? "var(--pop-5)" : "var(--paper)",
              border: "1.5px solid var(--ink)",
              color: autoDetect ? "#fff" : "var(--ink-2)",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              transition: "all .12s",
            }}
          >
            <Sparkles style={{ width: 12, height: 12 }} /> Auto-detect
          </button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx,.xls"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) acceptFile(f);
        }}
      />
      <div
        data-walkthrough="tradebook-import-drop"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) acceptFile(f);
        }}
        style={{
          marginTop: 6,
          padding: "32px 24px",
          textAlign: "center",
          border: "2px dashed",
          borderColor: dragOver ? "var(--emerald)" : "var(--ink)",
          background: dragOver ? "var(--emerald-bg)" : "var(--rule-softer)",
          borderRadius: 14,
          cursor: "pointer",
          transition: "all .15s",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            margin: "0 auto 14px",
            borderRadius: 14,
            background: "var(--pop-2)",
            border: "2px solid var(--ink)",
            color: "#1d1d1b",
            boxShadow: "3px 3px 0 var(--ink)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <UploadCloud style={{ width: 26, height: 26 }} />
        </div>
        <div
          style={{
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: -0.4,
            marginBottom: 4,
            color: "var(--ink)",
          }}
        >
          {file ? file.name : "Drop CSV here"}
        </div>
        <div
          style={{
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
            fontSize: 15,
            color: "var(--ink-3)",
          }}
        >
          or click to browse · CSV, XLSX, XLS · up to 10 MB
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <Info style={{ width: 13, height: 13, color: "var(--ink-3)" }} />
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Need a template?{" "}
          <a
            href="/tradebook-template.csv"
            download="usemoney-tradebook-template.csv"
            style={{
              color: "var(--emerald-text)",
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            Download sample CSV →
          </a>
        </span>
      </div>
    </>
  );
}

/* =====================================================================
   STEP 2 - Mapped columns + preview stats
   ===================================================================== */

function Step2Map({
  isPreviewing,
  previewStats,
  previewRows,
  previewErrors,
  formatLabel,
  onBack,
  onContinue,
}: {
  isPreviewing: boolean;
  previewStats: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    columns: string[];
  } | null;
  previewRows: PreviewRow[];
  previewErrors: string[];
  formatLabel: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  /* Column mapping definition (representative of the broker schema) */
  const mappings = [
    { f: "timestamp *", c: "trade_date + trade_time" },
    { f: "ticker *", c: "symbol" },
    { f: "side *", c: "trade_type" },
    { f: "qty *", c: "quantity" },
    { f: "price *", c: "trade_price" },
    { f: "exchange", c: "exchange" },
    { f: "product", c: "order_type" },
  ];

  return (
    <>
      <div className="ttl" style={{ marginBottom: 10 }}>
        STEP 2 · MAP COLUMNS
      </div>
      <h3
        style={{
          margin: "0 0 4px",
          fontSize: 19,
          fontWeight: 800,
          letterSpacing: -0.4,
          color: "var(--ink)",
        }}
      >
        We matched your columns automatically.
      </h3>
      <p
        style={{
          margin: "0 0 18px",
          fontFamily: "Instrument Serif, serif",
          fontStyle: "italic",
          color: "var(--ink-3)",
          fontSize: 15,
        }}
      >
        Confirm the mapping for{" "}
        <span
          className="mono"
          style={{
            color: "var(--emerald-text)",
            fontStyle: "normal",
            fontWeight: 700,
          }}
        >
          {formatLabel}
        </span>{" "}
        format. Required fields are marked{" "}
        <span style={{ color: "var(--pop-1-text)" }}>*</span>.
      </p>

      {isPreviewing && (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: "var(--ink-3)",
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
            fontSize: 15,
          }}
        >
          Reading file… this can take a moment for large workbooks.
        </div>
      )}

      {!isPreviewing && previewErrors.length > 0 && (
        <div
          style={{
            marginBottom: 14,
            padding: 12,
            background: "rgba(255,107,53,.08)",
            border: "1.5px solid var(--pop-1)",
            borderRadius: 10,
            color: "var(--pop-1-text)",
            fontSize: 12.5,
          }}
        >
          <div
            style={{
              fontWeight: 700,
              marginBottom: 4,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <AlertTriangle style={{ width: 14, height: 14 }} />
            We could not parse this file:
          </div>
          {previewErrors.map((e, i) => (
            <div
              key={i}
              className="mono"
              style={{ fontSize: 11.5, marginTop: 2 }}
            >
              · {e}
            </div>
          ))}
        </div>
      )}

      {/* No row parsed successfully: surface WHY (top per-row reasons) and
          point at the standard template instead of leaving a dead disabled
          "Continue" button. (MONEY-1074) */}
      {!isPreviewing &&
        previewStats &&
        previewStats.totalRows > 0 &&
        previewStats.validRows === 0 && (
          <div
            style={{
              marginBottom: 14,
              padding: 12,
              background: "rgba(255,107,53,.08)",
              border: "1.5px solid var(--pop-1)",
              borderRadius: 10,
              color: "var(--pop-1-text)",
              fontSize: 12.5,
            }}
          >
            <div
              style={{
                fontWeight: 700,
                marginBottom: 4,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <AlertTriangle style={{ width: 14, height: 14 }} />
              None of the {previewStats.totalRows} rows could be read.
            </div>
            {Array.from(
              new Set(
                previewRows.filter((r) => r.error).map((r) => r.error as string)
              )
            )
              .slice(0, 3)
              .map((e, i) => (
                <div
                  key={i}
                  className="mono"
                  style={{ fontSize: 11.5, marginTop: 2 }}
                >
                  · {e}
                </div>
              ))}
            <div style={{ marginTop: 8, color: "var(--ink-2)" }}>
              This usually means the file isn&apos;t a recognised broker export.
              Try the{" "}
              <a
                href="/tradebook-template.csv"
                download
                style={{
                  color: "var(--emerald-text)",
                  fontWeight: 700,
                  textDecoration: "underline",
                }}
              >
                standard template
              </a>
              , or pick your broker above and re-upload.
            </div>
          </div>
        )}

      {!isPreviewing && previewStats && (
        <>
          {/* Column mapping table (scrolls on mobile) */}
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <div
              style={{
                border: "1.5px solid var(--ink)",
                borderRadius: 10,
                overflow: "hidden",
                minWidth: 480,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.2fr 24px 1.2fr 1.6fr",
                  padding: "10px 14px",
                  background: "var(--rule-softer)",
                  borderBottom: "1.5px solid var(--ink)",
                }}
                className="ttl"
              >
                <div>From CSV</div>
                <div />
                <div>UseMoney field</div>
                <div>Status</div>
              </div>
              {mappings.map((row, i) => (
                <div
                  key={row.f}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.2fr 24px 1.2fr 1.6fr",
                    padding: "11px 14px",
                    alignItems: "center",
                    fontSize: 13,
                    borderBottom:
                      i < mappings.length - 1
                        ? "1px dashed var(--rule-soft)"
                        : "none",
                    background: i % 2 ? "var(--rule-softer)" : "transparent",
                  }}
                >
                  <div
                    className="mono"
                    style={{ fontWeight: 600, color: "var(--ink)" }}
                  >
                    {row.c}
                  </div>
                  <div style={{ color: "var(--ink-3)", textAlign: "center" }}>
                    →
                  </div>
                  <div>
                    <span
                      style={{
                        display: "inline-flex",
                        padding: "3px 10px",
                        border: "1.5px solid var(--ink)",
                        borderRadius: 999,
                        background: "var(--emerald-bg)",
                        color: "var(--emerald-text)",
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      {row.f}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                  >
                    <Check
                      style={{
                        width: 12,
                        height: 12,
                        color: "var(--emerald-text)",
                      }}
                    />
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: "var(--emerald-text)",
                        fontWeight: 700,
                      }}
                    >
                      Mapped
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Stats banner */}
          <div
            style={{
              padding: "10px 14px",
              background: "var(--emerald-bg)",
              border: "1.5px solid var(--emerald)",
              borderRadius: 10,
              marginBottom: 16,
              fontSize: 13,
              color: "var(--ink-2)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <Check
              style={{ width: 13, height: 13, color: "var(--emerald-text)" }}
            />
            <span
              className="mono"
              style={{ color: "var(--emerald-text)", fontWeight: 800 }}
            >
              {previewStats.validRows} valid
            </span>
            <span style={{ color: "var(--ink-3)" }}>of</span>
            <span
              className="mono"
              style={{ fontWeight: 800, color: "var(--ink)" }}
            >
              {previewStats.totalRows}
            </span>
            <span style={{ color: "var(--ink-3)" }}>rows</span>
            {previewStats.invalidRows > 0 ? (
              <>
                <span style={{ color: "var(--ink-3)" }}>·</span>
                <span
                  className="mono"
                  style={{ color: "var(--pop-1-text)", fontWeight: 700 }}
                >
                  {previewStats.invalidRows} skipped
                </span>
              </>
            ) : (
              <>
                <span style={{ color: "var(--ink-3)" }}>·</span>
                <span style={{ color: "var(--ink-3)" }}>no errors</span>
              </>
            )}
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        <button type="button" className="pf-bf" onClick={onBack}>
          ← Back
        </button>
        <button
          type="button"
          className="pf-bs"
          disabled={!previewStats || previewStats.validRows === 0}
          onClick={onContinue}
        >
          Continue to review →
        </button>
      </div>
    </>
  );
}

/* =====================================================================
   STEP 3 - Review (with row checkboxes + duplicate flagging)
   ===================================================================== */

function Step3Review({
  previewRows,
  previewStats,
  selectedRows,
  toggleRow,
  brokerConnections,
  selectedConnection,
  setSelectedConnection,
  onBack,
  onImport,
}: {
  previewRows: PreviewRow[];
  previewStats: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    columns: string[];
  } | null;
  selectedRows: Set<number>;
  toggleRow: (idx: number) => void;
  brokerConnections: BrokerConnection[];
  selectedConnection: string;
  setSelectedConnection: (v: string) => void;
  onBack: () => void;
  onImport: () => void;
}) {
  const newRows = previewStats?.validRows ?? 0;
  const errorRows = previewStats?.invalidRows ?? 0;

  return (
    <>
      <div className="ttl" style={{ marginBottom: 10 }}>
        STEP 3 · REVIEW
      </div>
      <h3
        style={{
          margin: "0 0 4px",
          fontSize: 19,
          fontWeight: 800,
          letterSpacing: -0.4,
          color: "var(--ink)",
        }}
      >
        Found {previewStats?.totalRows ?? previewRows.length} trades.
      </h3>
      <p
        style={{
          margin: "0 0 16px",
          fontFamily: "Instrument Serif, serif",
          fontStyle: "italic",
          color: "var(--ink-3)",
          fontSize: 15,
        }}
      >
        <span
          className="mono"
          style={{
            color: "var(--emerald-text)",
            fontStyle: "normal",
            fontWeight: 700,
          }}
        >
          {newRows} valid
        </span>
        {" · "}
        <span
          className="mono"
          style={{
            color: errorRows > 0 ? "var(--pop-1-text)" : "var(--ink-3)",
            fontStyle: "normal",
          }}
        >
          {errorRows} errors
        </span>
      </p>

      {brokerConnections.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="ttl" style={{ display: "block", marginBottom: 8 }}>
            LINK TO BROKER ACCOUNT
          </div>
          <select
            value={selectedConnection}
            onChange={(e) => setSelectedConnection(e.target.value)}
            style={{
              width: "100%",
              padding: "9px 12px",
              border: "1.5px solid var(--ink)",
              borderRadius: 8,
              background: "var(--paper)",
              color: "var(--ink)",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <option value="none">— Don&apos;t link to any account —</option>
            <option value="manual">Manual / Off-market</option>
            {brokerConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.accountName || c.broker}
                {c.brokerUserId ? ` · ${c.brokerUserId}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Trade preview table — scrolls horizontally on mobile */}
      <div style={{ overflowX: "auto", marginBottom: 14 }}>
        <div style={{ maxHeight: 380, overflow: "auto", minWidth: 560 }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 12,
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1.5px solid var(--ink)",
                  background: "var(--rule-softer)",
                }}
              >
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "left",
                    fontWeight: 700,
                    letterSpacing: 1,
                    fontSize: 10,
                    color: "var(--ink-3)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={
                      selectedRows.size > 0 &&
                      selectedRows.size === previewRows.length
                    }
                    onChange={(e) => {
                      if (e.target.checked) {
                        previewRows.forEach((_, i) => {
                          if (!selectedRows.has(i)) toggleRow(i);
                        });
                      } else {
                        previewRows.forEach((_, i) => {
                          if (selectedRows.has(i)) toggleRow(i);
                        });
                      }
                    }}
                  />
                </th>
                {["TIMESTAMP", "TICKER", "SIDE", "QTY", "PRICE", "STATUS"].map(
                  (h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign:
                          h === "QTY" || h === "PRICE" ? "right" : "left",
                        fontWeight: 700,
                        letterSpacing: 1,
                        fontSize: 10,
                        color: "var(--ink-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r, i) => {
                const ts = readField(r, [
                  "timestamp",
                  "tradeDate",
                  "trade_date",
                  "date",
                ]);
                const sym = readField(r, ["symbol", "ticker"]);
                const side = readField(r, ["side", "tradeType", "trade_type"]);
                const qty = readField(r, ["quantity", "qty"]);
                const price = readField(r, ["price", "trade_price"]);
                const hasErr = !!r.error;
                return (
                  <tr
                    key={i}
                    style={{
                      background: hasErr
                        ? "rgba(255,107,53,.04)"
                        : i % 2
                          ? "var(--rule-softer)"
                          : "transparent",
                      borderBottom: "1px dashed var(--rule-soft)",
                    }}
                  >
                    <td style={{ padding: "8px 10px" }}>
                      <input
                        type="checkbox"
                        checked={selectedRows.has(i)}
                        onChange={() => toggleRow(i)}
                      />
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        color: "var(--ink-3)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ts}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        color: "var(--emerald-text)",
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {sym}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span
                        className="pf-pill"
                        style={{
                          fontSize: 9.5,
                          background:
                            side === "BUY" || side === "B"
                              ? "var(--emerald-bg)"
                              : "rgba(255,107,53,.1)",
                          color:
                            side === "BUY" || side === "B"
                              ? "var(--emerald-text)"
                              : "var(--pop-1-text)",
                          border: "1.5px solid var(--ink)",
                        }}
                      >
                        {side}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {qty}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        fontWeight: 700,
                        color: "var(--ink)",
                      }}
                    >
                      {price}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {hasErr ? (
                        <span
                          className="pf-pill coral"
                          style={{ fontSize: 9.5 }}
                        >
                          ● Error
                        </span>
                      ) : (
                        <span
                          className="pf-pill emerald"
                          style={{ fontSize: 9.5 }}
                        >
                          ● New
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Duplicate note */}
      <div
        style={{
          marginBottom: 14,
          padding: "10px 14px",
          background: "rgba(167,139,250,.06)",
          border: "1.5px solid var(--pop-5)",
          borderRadius: 10,
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <Info
          style={{
            width: 14,
            height: 14,
            color: "var(--pop-5-text)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Duplicates are detected during import (matching on timestamp + ticker
          + qty). The summary on the next step shows how many were skipped or
          merged.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        <button type="button" className="pf-bf" onClick={onBack}>
          ← Back
        </button>
        <button
          type="button"
          className="pf-bs"
          disabled={selectedRows.size === 0}
          onClick={onImport}
        >
          Import {selectedRows.size} trades →
        </button>
      </div>
    </>
  );
}

/* Best-effort field reader - preview rows can come back with broker-
   specific column names depending on the format, so we try each
   candidate key in order. */
function readField(row: PreviewRow, keys: string[]): string {
  const raw = row as unknown as Record<string, unknown>;
  for (const k of keys) {
    const v = raw[k];
    if (v != null && v !== "") return String(v);
  }
  return "-";
}

/* =====================================================================
   STEP 4 - Done (success state with optional in-flight progress)
   ===================================================================== */

function Step4Done({
  imported,
  skipped,
  duplicateSynced,
  activeJobId,
  onComplete,
  onBackToList,
  onViewHistory,
}: {
  imported: number;
  skipped: number;
  duplicateSynced: number;
  activeJobId: string | null;
  onComplete: (job: ImportJobStatus) => void;
  onBackToList: () => void;
  onViewHistory: () => void;
}) {
  if (activeJobId) {
    return (
      <>
        <div className="ttl" style={{ marginBottom: 10 }}>
          STEP 4 · IMPORTING
        </div>
        <h3
          style={{
            margin: "0 0 4px",
            fontSize: 19,
            fontWeight: 800,
            letterSpacing: -0.4,
            color: "var(--ink)",
          }}
        >
          Working on your import.
        </h3>
        <p
          style={{
            margin: "0 0 18px",
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
            color: "var(--ink-3)",
            fontSize: 15,
          }}
        >
          You can navigate away — progress is saved on the server.
        </p>
        <ImportProgress
          jobId={activeJobId}
          onComplete={onComplete}
          onError={(err) => toast.error(err)}
        />
      </>
    );
  }

  return (
    <div style={{ textAlign: "center", padding: "32px 16px" }}>
      {/* Success icon */}
      <div
        style={{
          width: 64,
          height: 64,
          margin: "0 auto 16px",
          borderRadius: 16,
          background: "var(--emerald-bg)",
          border: "2px solid var(--emerald)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--emerald)",
          boxShadow: "4px 4px 0 var(--ink)",
          transform: "rotate(-2deg)",
        }}
      >
        <Check style={{ width: 28, height: 28 }} />
      </div>
      <h3
        style={{
          fontSize: 24,
          fontWeight: 800,
          letterSpacing: -0.6,
          margin: "0 0 6px",
          color: "var(--ink)",
        }}
      >
        Import complete.
      </h3>
      <p
        style={{
          fontFamily: "Instrument Serif, serif",
          fontStyle: "italic",
          color: "var(--ink-3)",
          fontSize: 16,
          margin: "0 0 22px",
        }}
      >
        <span
          className="mono"
          style={{
            color: "var(--emerald-text)",
            fontStyle: "normal",
            fontWeight: 800,
          }}
        >
          {imported}
        </span>{" "}
        trades added
        {skipped > 0 && (
          <>
            {" · "}
            <span
              className="mono"
              style={{
                color: "var(--pop-2-text)",
                fontStyle: "normal",
                fontWeight: 700,
              }}
            >
              {skipped}
            </span>{" "}
            skipped (duplicates)
          </>
        )}
        {duplicateSynced > 0 && (
          <>
            {" · "}
            <span
              className="mono"
              style={{
                color: "var(--emerald-text)",
                fontStyle: "normal",
                fontWeight: 700,
              }}
            >
              {duplicateSynced}
            </span>{" "}
            synced to existing
          </>
        )}
      </p>
      <div
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        <button type="button" className="pf-bf" onClick={onViewHistory}>
          <History style={{ width: 13, height: 13 }} /> View import history
        </button>
        <button type="button" className="pf-bs" onClick={onBackToList}>
          <Plus style={{ width: 13, height: 13 }} /> Go to tradebook →
        </button>
      </div>
    </div>
  );
}
