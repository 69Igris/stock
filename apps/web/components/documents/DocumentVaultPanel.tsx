"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, Search, Upload } from "lucide-react";
import {
  getDocumentsAction,
  uploadDocumentAction,
} from "@/lib/actions/documents";

/**
 * Shared "Document Vault" panel - a search bar + scrollable typed list
 * (file-type chip + name + size · date + select checkbox) + a full-width
 * dashed "Upload document" button.
 *
 * Used in two places so they stay identical:
 *   1. ResearchModal - attach docs to a research run (real string ids).
 *   2. Chat composer (PromptOptionsPopover) - pin docs to a chat turn.
 *
 * The component is presentational over the existing document actions:
 * it lists via `getDocumentsAction`, uploads via `uploadDocumentAction`,
 * and is fully controlled for selection (`selectedIds` + `onToggle`) so
 * each surface keeps its own attach wiring. The panel never owns the
 * "what is attached" truth.
 */

export interface VaultDocument {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  documentType: string;
  processingStatus: string;
  createdAt: Date | string;
}

interface DocumentVaultPanelProps {
  /** Selected document ids (real string ids). Controlled by the parent. */
  selectedIds: string[];
  /** Toggle a document's selection. The parent owns the attach state. */
  onToggle: (id: string) => void;
  /**
   * Optional pre-fetched docs. When omitted the panel fetches its own
   * list via `getDocumentsAction({ limit })`.
   */
  documents?: VaultDocument[];
  /**
   * Only list docs whose `processingStatus === "READY"`. ResearchModal
   * attaches indexed docs only; the chat composer shows everything.
   */
  onlyReady?: boolean;
  /** Page size when self-fetching. Default 50. */
  limit?: number;
  /**
   * Fired after a successful upload with the new document id, so the
   * parent can auto-select it. The panel also refreshes its own list.
   */
  onUploaded?: (documentId: string) => void;
  /** Max height (px) of the scrollable list area. Default 200. */
  listMaxHeight?: number;
}

// File-type chip palette (mirrors the chat-composer doc rows).
const DOC_TYPE_BG: Record<string, string> = {
  pdf: "rgba(248,113,113,0.10)",
  csv: "rgba(74,222,128,0.10)",
  xls: "rgba(34,197,94,0.10)",
  txt: "rgba(148,163,184,0.10)",
  md: "rgba(167,139,250,0.10)",
  img: "rgba(56,189,248,0.10)",
};
const DOC_TYPE_FG: Record<string, string> = {
  pdf: "#f87171",
  csv: "#4ade80",
  xls: "#22c55e",
  txt: "#94a3b8",
  md: "#a78bfa",
  img: "#38bdf8",
};

type ChipType = keyof typeof DOC_TYPE_BG;

function chipType(doc: VaultDocument): ChipType {
  const ext = doc.fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "csv") return "csv";
  if (ext === "xls" || ext === "xlsx") return "xls";
  if (ext === "md") return "md";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "img";
  if (ext === "txt") return "txt";
  // Fall back to documentType when the filename has no useful extension.
  const dt = doc.documentType.toUpperCase();
  if (dt === "PDF") return "pdf";
  if (dt === "CSV") return "csv";
  if (dt === "SPREADSHEET") return "xls";
  if (dt === "IMAGE") return "img";
  return "txt";
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  const ms = Date.now() - date.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days <= 0) {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours <= 0) return "just now";
    return `${hours}h ago`;
  }
  if (days === 1) return "1 d ago";
  if (days < 30) return `${days} d ago`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// Accepted upload extensions (matches the documents page + composer).
const ACCEPT = ".pdf,.csv,.xls,.xlsx,.png,.jpg,.jpeg,.webp";

export function DocumentVaultPanel({
  selectedIds,
  onToggle,
  documents: externalDocs,
  onlyReady = false,
  limit = 50,
  onUploaded,
  listMaxHeight = 200,
}: DocumentVaultPanelProps) {
  const selfFetch = externalDocs === undefined;
  const [fetched, setFetched] = useState<VaultDocument[] | null>(
    selfFetch ? null : (externalDocs ?? [])
  );
  const [query, setQuery] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await getDocumentsAction({ limit });
    if (res.success && res.data) {
      setFetched(
        res.data.documents.map((d) => ({
          id: d.id,
          title: d.title,
          fileName: d.fileName,
          fileSize: d.fileSize,
          documentType: d.documentType,
          processingStatus: d.processingStatus,
          createdAt: d.createdAt,
        }))
      );
    } else {
      setFetched([]);
    }
  }, [limit]);

  useEffect(() => {
    if (selfFetch) void refresh();
  }, [selfFetch, refresh]);

  // Keep in sync when a controlled parent swaps the externalDocs list.
  useEffect(() => {
    if (!selfFetch) setFetched(externalDocs ?? []);
  }, [selfFetch, externalDocs]);

  const allDocs = fetched ?? [];

  const visibleDocs = useMemo(() => {
    const base = onlyReady
      ? allDocs.filter((d) => d.processingStatus === "READY")
      : allDocs;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (d) =>
        d.fileName.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q)
    );
  }, [allDocs, onlyReady, query]);

  const handleUploadClick = () => {
    setUploadError(null);
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("title", file.name);
      fd.set("category", "OTHER");
      const res = await uploadDocumentAction(fd);
      if (!res.success) {
        setUploadError(res.error ?? "Upload failed");
        return;
      }
      const newId = res.data?.documentId;
      // Refresh so the freshly-uploaded doc appears in the list.
      if (selfFetch) await refresh();
      if (newId) onUploaded?.(newId);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadBusy(false);
    }
  };

  const loading = fetched === null;

  return (
    <div
      style={{
        borderRadius: 10,
        border: "1.5px solid var(--rule-soft)",
        background: "var(--paper-2)",
        padding: 10,
      }}
    >
      {/* Search bar with N/M counter */}
      <div
        className="flex items-center gap-2 mb-2"
        style={{
          padding: "8px 10px",
          borderRadius: 10,
          background: "var(--paper)",
          border: "1.5px solid var(--rule-softer)",
        }}
      >
        <Search className="w-[13px] h-[13px] text-[var(--ink-3)] shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${visibleDocs.length} documents…`}
          className="flex-1 min-w-0 outline-none"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--ink)",
            fontSize: 12.5,
          }}
        />
        <span
          className="font-mono shrink-0"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            padding: "1px 5px",
            borderRadius: 4,
            background: "var(--paper-2)",
          }}
        >
          {selectedIds.length}/{visibleDocs.length}
        </span>
      </div>

      {/* List */}
      {loading ? (
        <div
          className="mono flex items-center justify-center gap-2"
          style={{ padding: "16px 0", fontSize: 11, color: "var(--ink-3)" }}
        >
          <Loader2
            className="h-3.5 w-3.5 animate-spin"
            style={{ color: "var(--emerald)" }}
          />
          Loading documents…
        </div>
      ) : visibleDocs.length === 0 ? (
        <div className="px-2 py-5 flex flex-col items-center text-center">
          <span
            className="grid place-items-center w-10 h-10 rounded-xl mb-2.5"
            style={{
              background: "var(--paper)",
              border: "1px solid rgba(52,211,153,0.15)",
              color: "var(--emerald)",
            }}
          >
            <FolderOpen className="h-4 w-4" />
          </span>
          <div
            className="text-[11.5px] leading-snug"
            style={{ color: "var(--ink-3)", maxWidth: 240 }}
          >
            {query.trim()
              ? "No documents match your search."
              : onlyReady
                ? "No indexed documents yet. Upload one below to attach it."
                : "No documents yet. Upload one below to get started."}
          </div>
        </div>
      ) : (
        <div
          className="overflow-y-auto pr-1"
          style={{
            maxHeight: listMaxHeight,
            scrollbarColor: "var(--rule-soft) transparent",
          }}
        >
          {visibleDocs.map((doc) => {
            const on = selectedIds.includes(doc.id);
            const t = chipType(doc);
            return (
              <button
                key={doc.id}
                type="button"
                onClick={() => onToggle(doc.id)}
                className="w-full text-left flex items-center gap-2.5 mb-px"
                style={{
                  padding: "8px 8px",
                  borderRadius: 8,
                  background: on ? "var(--paper)" : "transparent",
                  border: 0,
                  cursor: "pointer",
                  color: "var(--ink)",
                }}
              >
                {/* Select checkbox */}
                <span
                  className="grid place-items-center shrink-0"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 5,
                    background: on ? "var(--emerald)" : "transparent",
                    border: `1.5px solid ${on ? "var(--emerald)" : "var(--rule-soft)"}`,
                    color: "var(--paper)",
                  }}
                >
                  {on && <Check className="h-2.5 w-2.5" />}
                </span>
                {/* File-type chip */}
                <span
                  className="grid place-items-center font-mono font-bold shrink-0"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: DOC_TYPE_BG[t],
                    color: DOC_TYPE_FG[t],
                    fontSize: 9,
                    letterSpacing: 0.4,
                  }}
                >
                  {t === "img" ? "IMG" : t.toUpperCase()}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-medium truncate text-[var(--ink)]">
                    {doc.fileName || doc.title}
                  </div>
                  <div
                    className="font-mono mt-0.5 flex gap-2 items-center"
                    style={{ fontSize: 10, color: "var(--ink-3)" }}
                  >
                    <span>{formatBytes(doc.fileSize)}</span>
                    <span>·</span>
                    <span>{relativeDate(doc.createdAt)}</span>
                    {!onlyReady && doc.processingStatus !== "READY" && (
                      <>
                        <span>·</span>
                        <span
                          className="uppercase"
                          style={{ letterSpacing: 0.4 }}
                        >
                          {doc.processingStatus}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        onChange={handleFileSelected}
        style={{ display: "none" }}
      />
      <button
        type="button"
        onClick={handleUploadClick}
        disabled={uploadBusy}
        className="w-full inline-flex items-center justify-center gap-1.5 mt-2"
        style={{
          padding: 9,
          borderRadius: 9,
          background: "transparent",
          border: "1.5px dashed var(--rule-soft)",
          color: "var(--ink-3)",
          fontSize: 11.5,
          fontWeight: 500,
          cursor: uploadBusy ? "wait" : "pointer",
          opacity: uploadBusy ? 0.7 : 1,
        }}
      >
        {uploadBusy ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Upload className="w-3 h-3" />
        )}
        {uploadBusy ? "Uploading…" : "Upload document"}
      </button>
      {uploadError && (
        <div
          className="mt-1 text-[10.5px] text-center"
          style={{ color: "var(--semantic-negative-text)" }}
        >
          {uploadError}
        </div>
      )}
    </div>
  );
}

export default DocumentVaultPanel;
