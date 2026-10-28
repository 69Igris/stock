"use client";

/* =====================================================================
   Tax Report v2 — playful flow dialogs (MONEY-485)
   Self-contained modal (overlay + pf-card) so we keep full control over
   the playful look rather than fighting shadcn DialogContent styling.
   Used by: AIS upload, harvest confirm, export center.
   ===================================================================== */

import { useEffect, type ReactNode } from "react";
import {
  X,
  Upload,
  Lock,
  Sparkles,
  Download,
  FileText,
  Check,
} from "lucide-react";
import { Pill } from "./primitives";

/* ── Base modal shell ────────────────────────────────────────────── */

export function PlayfulDialog({
  open,
  onClose,
  title,
  eyebrow,
  children,
  maxWidth = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: string;
  children: ReactNode;
  maxWidth?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(0,0,0,0.55)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pf-card"
        style={{
          width: "100%",
          maxWidth,
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "var(--shadow-hard)",
        }}
      >
        <div
          className="flex items-start justify-between"
          style={{ gap: 12, marginBottom: 14 }}
        >
          <div>
            {eyebrow ? (
              <div
                className="mono"
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  color: "var(--emerald-text)",
                }}
              >
                {eyebrow}
              </div>
            ) : null}
            <div
              style={{
                fontSize: 19,
                fontWeight: 800,
                letterSpacing: -0.4,
                marginTop: 4,
              }}
            >
              {title}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="pf-tb-icon-btn"
            style={{ width: 32, height: 32, flexShrink: 0 }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── AIS upload dialog ───────────────────────────────────────────── */

export function AISUploadDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <PlayfulDialog
      open={open}
      onClose={onClose}
      eyebrow="RECONCILE · AIS"
      title={
        <>
          Upload your <span className="ser">Annual Information Statement.</span>
        </>
      }
    >
      <div
        style={{
          border: "2px dashed var(--ink)",
          borderRadius: 14,
          padding: 30,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          background: "var(--paper-2)",
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 13,
            background: "var(--emerald)",
            color: "var(--paper)",
            display: "grid",
            placeItems: "center",
            border: "2px solid var(--ink)",
            transform: "rotate(-3deg)",
          }}
        >
          <Upload className="h-6 w-6" />
        </div>
        <div style={{ fontSize: 15, fontWeight: 800 }}>
          Drop your AIS PDF here
        </div>
        <div
          className="ser"
          style={{
            fontSize: 13.5,
            color: "var(--ink-3)",
            maxWidth: 380,
            lineHeight: 1.45,
          }}
        >
          Download it from the income-tax portal &rarr; Compliance &rarr; AIS.
          We&rsquo;ll parse it line-by-line and flag where our numbers disagree.
        </div>
        <Pill tone="gold">reconcile engine · coming soon · MONEY-486</Pill>
      </div>
      <div
        className="flex items-center gap-3 mono"
        style={{
          marginTop: 14,
          fontSize: 11,
          color: "var(--ink-3)",
          flexWrap: "wrap",
        }}
      >
        <span className="inline-flex items-center gap-1.5">
          <Lock className="h-3 w-3" /> processed securely
        </span>
        <span>· PDF · 5&ndash;15 pages</span>
      </div>
      <div
        className="flex items-center gap-2"
        style={{ marginTop: 16, justifyContent: "flex-end" }}
      >
        <button type="button" className="pf-bf sm" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="pf-bs sm"
          disabled
          style={{ opacity: 0.5 }}
        >
          <Upload className="h-3 w-3" /> Browse files
        </button>
      </div>
    </PlayfulDialog>
  );
}

/* ── Harvest confirm dialog ──────────────────────────────────────── */

export function HarvestConfirmDialog({
  open,
  onClose,
  symbol,
  potentialSaving,
  unrealizedLoss,
  gaarWarning,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string | null;
  potentialSaving: number;
  unrealizedLoss: number;
  gaarWarning: string;
}) {
  const fmt = (n: number) =>
    n.toLocaleString("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    });

  return (
    <PlayfulDialog
      open={open}
      onClose={onClose}
      eyebrow="OPTIMIZE · HARVEST"
      title={
        <>
          Harvest plan for{" "}
          <span className="ser">{symbol ?? "this holding"}.</span>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div
          className="flex items-center justify-between"
          style={{
            padding: 12,
            background: "var(--paper-2)",
            borderRadius: 10,
            border: "1.5px solid var(--rule-soft)",
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-3)" }}
          >
            Realise loss
          </span>
          <span className="mono neg" style={{ fontWeight: 800 }}>
            {fmt(-Math.abs(unrealizedLoss))}
          </span>
        </div>
        <div
          className="flex items-center justify-between"
          style={{
            padding: 12,
            background: "var(--emerald-bg)",
            borderRadius: 10,
            border: "1.5px solid var(--emerald)",
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-2)" }}
          >
            Estimated tax saved
          </span>
          <span
            className="mono"
            style={{ fontWeight: 800, color: "var(--emerald-text)" }}
          >
            +{fmt(potentialSaving)}
          </span>
        </div>
        {gaarWarning ? (
          <div
            className="flex gap-2"
            style={{
              padding: 12,
              background: "var(--rule-softer)",
              borderRadius: 10,
              border: "1.5px dashed var(--pop-2)",
            }}
          >
            <Sparkles
              className="h-4 w-4 shrink-0"
              style={{ color: "var(--pop-2-text)", marginTop: 2 }}
            />
            <div
              style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5 }}
            >
              {gaarWarning}
            </div>
          </div>
        ) : null}
        <div
          className="flex items-center gap-2"
          style={{ marginTop: 4, justifyContent: "flex-end" }}
        >
          <button type="button" className="pf-bf sm" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="pf-bs sm"
            disabled
            style={{ opacity: 0.5 }}
          >
            Place order · coming soon
          </button>
        </div>
      </div>
    </PlayfulDialog>
  );
}

/* ── Export center dialog ────────────────────────────────────────── */

const EXPORT_ITEMS: Array<{
  id: string;
  title: string;
  sub: string;
  badge: string;
  ready: boolean;
}> = [
  {
    id: "itr2",
    title: "ITR-2 JSON",
    sub: "ready to upload to incometax.gov.in",
    badge: "JSON",
    ready: true,
  },
  {
    id: "cg",
    title: "Capital gains CSV",
    sub: "FIFO-matched, annexure-ready",
    badge: "CSV",
    ready: true,
  },
  {
    id: "capdf",
    title: "CA-ready PDF",
    sub: "annotated computation sheet",
    badge: "PDF",
    ready: false,
  },
  {
    id: "itr3",
    title: "ITR-3 JSON",
    sub: "for F&O / business income",
    badge: "JSON",
    ready: false,
  },
];

export function ExportDialog({
  open,
  onClose,
  csvData,
  summary,
  fy,
}: {
  open: boolean;
  onClose: () => void;
  csvData: string;
  summary: string;
  fy: string;
}) {
  const downloadCsv = () => {
    if (!csvData) return;
    const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usemoney-capital-gains-FY${fy}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <PlayfulDialog
      open={open}
      onClose={onClose}
      eyebrow="FILE · EXPORTS"
      title={
        <>
          Take it <span className="ser">elsewhere.</span>
        </>
      }
      maxWidth={560}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {EXPORT_ITEMS.map((it) => {
          const csvReady = it.id === "cg" && Boolean(csvData);
          const enabled = it.id === "cg" ? csvReady : false;
          return (
            <div
              key={it.id}
              className="pf-card flat"
              style={{ background: "var(--paper-2)", padding: 14 }}
            >
              <div className="flex items-start justify-between">
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 9,
                    background: "var(--emerald)",
                    color: "var(--paper)",
                    display: "grid",
                    placeItems: "center",
                    border: "1.5px solid var(--ink)",
                    transform: "rotate(-3deg)",
                  }}
                >
                  <FileText className="h-4 w-4" />
                </span>
                <Pill>{it.badge}</Pill>
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 800,
                  letterSpacing: -0.3,
                  marginTop: 10,
                }}
              >
                {it.title}
              </div>
              <div
                className="mono"
                style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}
              >
                {it.sub}
              </div>
              {enabled ? (
                <button
                  type="button"
                  className="pf-bs sm"
                  style={{
                    marginTop: 12,
                    width: "100%",
                    justifyContent: "center",
                  }}
                  onClick={it.id === "cg" ? downloadCsv : undefined}
                >
                  <Download className="h-3 w-3" /> Download
                </button>
              ) : (
                <button
                  type="button"
                  className="pf-bf sm"
                  disabled
                  style={{
                    marginTop: 12,
                    width: "100%",
                    justifyContent: "center",
                    opacity: 0.55,
                  }}
                >
                  <Lock className="h-3 w-3" /> coming soon
                </button>
              )}
            </div>
          );
        })}
      </div>
      {summary ? (
        <div
          className="flex gap-2"
          style={{
            marginTop: 14,
            padding: 12,
            background: "var(--rule-softer)",
            borderRadius: 10,
          }}
        >
          <Check
            className="h-4 w-4 shrink-0"
            style={{ color: "var(--emerald-text)" }}
          />
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)" }}
          >
            {summary}
          </span>
        </div>
      ) : null}
    </PlayfulDialog>
  );
}
