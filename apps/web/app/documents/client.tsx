"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useIDBCache } from "@/hooks/useIDBCache";
import { clearIDBDocumentsCache } from "@/lib/idb-cache";
import {
  FileText,
  Plus,
  ChevronDown,
  ArrowRight,
  X,
  ChevronLeft,
  ChevronRight,
  Upload,
  Loader2,
  Download,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@usemoney/ui/dropdown-menu";
import { Skeleton } from "@usemoney/ui/skeleton";
import Sidebar from "@/components/Sidebar";
import { TakeTheTourButton } from "@/components/walkthrough";

import { PageGuard } from "@/components/PageGuard";
import { DocumentsSkeleton } from "@/components/skeletons";
import { useAppFeatureFlags } from "@/lib/hooks/useAppFeatureFlags";
import { ViewToggle, useScreenerView } from "@/components/screener/ViewToggle";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import { UploadZone, type UploadZoneHandle } from "./components/UploadZone";
import { UrlImportInput } from "./components/UrlImportInput";
import { DocumentCard } from "./components/DocumentCard";
import {
  uploadDocumentAction,
  importFromUrlAction,
  getDocumentsAction,
  getDocumentAction,
  getDownloadUrlAction,
  deleteDocumentAction,
  generateReportAction,
} from "@/lib/actions/documents";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

// Filename patterns that suggest the file contains trade data (for tradebook import)
const TRADE_FILE_PATTERNS = [
  /trade/i,
  /order/i,
  /contract.?note/i,
  /tradebook/i,
  /ledger/i,
  /transaction/i,
  /buy.?sell/i,
  /portfolio.?statement/i,
];

const TRADE_FILE_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

function looksLikeTradeFile(file: File): boolean {
  if (!TRADE_FILE_TYPES.includes(file.type)) return false;
  return TRADE_FILE_PATTERNS.some((pattern) => pattern.test(file.name));
}

interface TradeSuggestion {
  file: File;
  category: string;
}

type CategoryFilter =
  | "ALL"
  | "BROKER_STATEMENT"
  | "TAX_REPORT"
  | "RISK_REPORT"
  | "RESEARCH_REPORT"
  | "OTHER";

const CATEGORY_TABS: { label: string; value: CategoryFilter }[] = [
  { label: "All", value: "ALL" },
  { label: "Broker Statements", value: "BROKER_STATEMENT" },
  { label: "Tax Reports", value: "TAX_REPORT" },
  { label: "Risk Reports", value: "RISK_REPORT" },
  { label: "Research List", value: "RESEARCH_REPORT" },
  { label: "Other", value: "OTHER" },
];

const PAGE_SIZE = 12;

interface DocumentItem {
  id: string;
  title: string;
  description: string | null;
  sourceType: string;
  documentType: string;
  category: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  processingStatus: string;
  /** MONEY-1168: why a FAILED import failed; null for every other status. */
  processingError: string | null;
  isEmbedded: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export default function DocumentsPageClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const [mounted, setMounted] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const uploadZoneRef = useRef<HTMLDivElement | null>(null);
  // MONEY-1167: the header CTA needs to OPEN the picker, not just scroll to
  // the zone — scrolling is a no-op when the zone is already on screen, which
  // made "Upload document" look like a dead button.
  const uploadZoneApiRef = useRef<UploadZoneHandle | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  // MONEY-394 E - Generate Report dropdown is gated on a new app-level
  // FF (`generate-report`). Users without the flag don't see the button.
  // The page itself is now ungated (always accessible).
  const { flags: appFlags } = useAppFeatureFlags();
  const canGenerateReport = appFlags["generate-report"];
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("ALL");
  const [viewMode, setViewMode] = useScreenerView("documents.view", "cards");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tradeSuggestions, setTradeSuggestions] = useState<TradeSuggestion[]>(
    []
  );
  const [page, setPage] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDemoMode = useIsDemoMode({ user });

  useEffect(() => {
    if (!isLoaded || !mounted) return;
    if (!user && !isDemoMode) {
      router.push("/home");
    }
  }, [isLoaded, mounted, user, isDemoMode, router]);

  const cacheFilters = useMemo(
    () => ({
      page,
      categoryFilter,
      searchQuery: searchQuery.trim(),
    }),
    [page, categoryFilter, searchQuery]
  );

  const {
    data: documentsData,
    isLoading,
    refresh,
  } = useIDBCache<{ documents: DocumentItem[]; total: number }>({
    module: "documents",
    identifier: "list",
    filters: cacheFilters as Record<string, unknown>,
    fetcher: async () => {
      const filters: Record<string, unknown> = {
        skip: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      };
      if (categoryFilter !== "ALL") filters.category = categoryFilter;
      if (searchQuery.trim()) filters.search = searchQuery.trim();

      const result = await getDocumentsAction(
        filters as Parameters<typeof getDocumentsAction>[0]
      );
      if (result?.success && result?.data) {
        return {
          documents: result?.data.documents,
          total: result?.data.total,
        };
      }
      throw new Error(result?.error || "Failed to load documents");
    },
    skip: !mounted || !isLoaded || (!user && !isDemoMode),
  });

  const documents = useMemo(
    () => documentsData?.documents ?? [],
    [documentsData?.documents]
  );
  const total = documentsData?.total ?? 0;

  // Poll for processing status updates
  useEffect(() => {
    const hasProcessing = documents.some(
      (d) =>
        d.processingStatus === "PENDING" || d.processingStatus === "PROCESSING"
    );
    if (!hasProcessing) return;

    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [documents, refresh]);

  const uploadFile = async (
    file: File,
    category: string,
    customName?: string,
    labels?: string[]
  ) => {
    setIsUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", customName || file.name);
      formData.append("category", category);
      if (customName) formData.append("customName", customName);
      if (labels && labels.length > 0)
        formData.append("labels", labels.join(","));

      const result = await uploadDocumentAction(formData);
      if (result?.success) {
        if (user?.id) await clearIDBDocumentsCache(user.id);
        await refresh();
      } else {
        setError(result?.error || "Upload failed");
      }
    } catch {
      setError("Upload failed");
    } finally {
      setIsUploading(false);
    }
  };

  const handleUpload = async (
    file: File,
    category: string,
    customName?: string,
    labels?: string[]
  ) => {
    // Detect trade-like files and accumulate suggestions
    if (looksLikeTradeFile(file)) {
      setTradeSuggestions((prev) => [...prev, { file, category }]);
      return;
    }
    await uploadFile(file, category, customName, labels);
  };

  const handleUrlImport = async (url: string) => {
    setIsImporting(true);
    setError(null);
    try {
      const result = await importFromUrlAction(url);
      if (result?.success) {
        if (user?.id) await clearIDBDocumentsCache(user.id);
        await refresh();
      } else {
        setError(result?.error || "Import failed");
      }
    } catch {
      setError("Import failed");
    } finally {
      setIsImporting(false);
    }
  };

  const handleView = async (id: string) => {
    const result = await getDocumentAction(id);
    if (result?.success && result?.data) {
      window.open(result?.data.viewUrl, "_blank");
    }
  };

  const handleDownload = async (id: string) => {
    setDownloadingId(id);
    try {
      const result = await getDownloadUrlAction(id);
      if (result?.success && result?.data) {
        // Use an anchor click to trigger browser download
        const a = document.createElement("a");
        a.href = result?.data.downloadUrl;
        a.download = result?.data.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const result = await deleteDocumentAction(id);
      if (result?.success) {
        if (user?.id) await clearIDBDocumentsCache(user.id);
        await refresh();
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleGenerateReport = async (type: string) => {
    setGeneratingReport(true);
    setError(null);
    try {
      const result = await generateReportAction(type);
      if (result?.success) {
        if (user?.id) await clearIDBDocumentsCache(user.id);
        await refresh();
      } else {
        setError(result?.error || "Report generation failed");
      }
    } catch {
      setError("Report generation failed");
    } finally {
      setGeneratingReport(false);
    }
  };

  // MONEY-392: chrome (Sidebar + container + Header) lives OUTSIDE
  // PageGuard so the header stays visible across stages 1 → 2 → 3.
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-4 sm:p-6 pb-48 sm:pb-44">
          {isDemoMode && <DemoBanner />}

          {/* Playful page header (pf-ph idiom, rendered inline). The
              primary CTAs (Upload + Generate Report) live in the actions
              slot; Take The Tour sits above on its own row. */}
          <PageGuard route="/documents" bare fallback={<DocumentsSkeleton />}>
            <div className="pf-ph">
              <div className="l">
                <div className="eyebrow">
                  <span className="d" aria-hidden />
                  TOOLS · DOCUMENT VAULT · OCR-SEARCHABLE
                </div>
                <h1>
                  Every statement, <span className="ser">findable.</span>
                </h1>
                <div className="sub">
                  Contract notes, broker statements, Form 26AS, MF summaries —
                  auto-organised and indexed for StockSage.
                </div>
              </div>
              <DemoGate
                isDemoMode={isDemoMode}
                message="Sign up to upload and generate reports"
              >
                <div
                  className="r flex-col !items-stretch sm:!items-end shrink-0"
                  data-walkthrough="documents-upload-cta"
                >
                  <div className="flex justify-end">
                    <TakeTheTourButton version="v1-documents" />
                  </div>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <button
                      onClick={() => {
                        uploadZoneRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        });
                        // Scrolling alone is invisible when the zone is
                        // already in view; actually start the upload.
                        uploadZoneApiRef.current?.openPicker();
                      }}
                      disabled={isUploading}
                      className="pf-bs"
                      style={
                        isUploading
                          ? { opacity: 0.5, cursor: "not-allowed" }
                          : undefined
                      }
                    >
                      {isUploading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="h-3.5 w-3.5" />
                      )}
                      Upload document
                    </button>
                    {canGenerateReport && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="pf-bf"
                            disabled={generatingReport}
                            style={
                              generatingReport
                                ? { opacity: 0.5, cursor: "not-allowed" }
                                : undefined
                            }
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Generate Report
                            <ChevronDown className="h-3 w-3" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="bg-card border-border"
                        >
                          {/* Tax Report + Risk Report generation hidden for
                            now - surface returns when reports are ready. */}
                          {/* <DropdownMenuItem
                          onClick={() => handleGenerateReport("tax")}
                          className="text-foreground/80 focus:bg-muted"
                        >
                          Tax Report (PDF)
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleGenerateReport("risk")}
                          className="text-foreground/80 focus:bg-muted"
                        >
                          Risk Report (PDF)
                        </DropdownMenuItem> */}
                          <DropdownMenuItem
                            onClick={() =>
                              handleGenerateReport("portfolio_statement")
                            }
                            className="text-foreground/80 focus:bg-muted"
                          >
                            Portfolio Statement (PDF)
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              </DemoGate>
            </div>

            {/* Error Banner */}
            {error && (
              <div
                className="rounded-xl p-3 mb-4"
                style={{
                  background: "var(--rule-softer)",
                  border: "1.5px solid var(--pop-1)",
                }}
              >
                <p className="text-sm" style={{ color: "var(--pop-1-text)" }}>
                  {error}
                </p>
              </div>
            )}

            {/* Trade File Suggestion Banner */}
            {tradeSuggestions.length > 0 && (
              <div
                className="pf-card mb-4"
                style={{ background: "var(--pop-2)", padding: 16 }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm font-bold"
                      style={{ color: "#1d1d1b" }}
                    >
                      {tradeSuggestions.length === 1
                        ? "This looks like a trade file"
                        : `${tradeSuggestions.length} files look like trade data`}
                    </p>
                    <p
                      className="text-xs mt-1 break-words"
                      style={{ color: "#3a3a35" }}
                    >
                      <span className="mono">
                        {tradeSuggestions.map((s) => s.file.name).join(", ")}
                      </span>{" "}
                      {tradeSuggestions.length === 1 ? "appears" : "appear"} to
                      contain trade data. Would you like to import{" "}
                      {tradeSuggestions.length === 1 ? "it" : "them"} into your
                      Tradebook instead? Tradebook import automatically pairs
                      trades and calculates P&L.
                    </p>
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        className="pf-bs sm"
                        style={{
                          background: "#1d1d1b",
                          color: "var(--pop-2)",
                          borderColor: "#1d1d1b",
                        }}
                        onClick={() => router.push("/tradebook/import")}
                      >
                        Import as Trades
                        <ArrowRight className="h-3 w-3 ml-1" />
                      </button>
                      <button
                        className="inline-flex items-center h-7 text-xs font-semibold"
                        style={{ color: "#3a3a35" }}
                        onClick={async () => {
                          const files = [...tradeSuggestions];
                          setTradeSuggestions([]);
                          for (const { file, category } of files) {
                            await uploadFile(file, category);
                          }
                        }}
                      >
                        Upload to Documents anyway
                        {tradeSuggestions.length > 1 &&
                          ` (${tradeSuggestions.length})`}
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={() => setTradeSuggestions([])}
                    className="p-0.5"
                    style={{ color: "#3a3a35" }}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Upload Zone */}
            <DemoGate
              isDemoMode={isDemoMode}
              message="Sign up to upload and import documents"
            >
              <div
                ref={uploadZoneRef}
                className="space-y-3 mb-6"
                data-walkthrough="documents-upload-zone"
              >
                <UploadZone
                  ref={uploadZoneApiRef}
                  onUpload={handleUpload}
                  isUploading={isUploading}
                />
                <UrlImportInput
                  onImport={handleUrlImport}
                  isImporting={isImporting}
                />
              </div>
            </DemoGate>

            {/* Sticky filter bar - DocumentVault.jsx pattern */}
            <div
              className="sticky top-0 z-[5] bg-background pt-2 pb-3 mb-3.5"
              style={{ borderBottom: "1.5px solid var(--rule-soft)" }}
              data-walkthrough="documents-filters"
            >
              <div className="flex items-center gap-3 flex-wrap">
                {/* Category pills with counts */}
                <div className="flex gap-1.5 flex-wrap">
                  {CATEGORY_TABS.map((tab) => {
                    const active = categoryFilter === tab.value;
                    const count =
                      tab.value === "ALL"
                        ? documents.length
                        : documents.filter((d) => d.category === tab.value)
                            .length;
                    return (
                      <button
                        key={tab.value}
                        onClick={() => {
                          setCategoryFilter(tab.value);
                          setPage(1);
                        }}
                        className={`pf-pill ${active ? "emerald" : "outline"} cursor-pointer`}
                      >
                        {tab.label}
                        {count > 0 && (
                          <span className="text-[9.5px] opacity-70">
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="flex-1" />
                {/* Search */}
                <input
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search documents..."
                  className="pf-input mono w-full sm:w-[220px]"
                  style={{ padding: "7px 10px", fontSize: 12 }}
                />
                {/* View mode toggle - cards vs list */}
                <ViewToggle value={viewMode} onChange={setViewMode} />
              </div>
            </div>

            {/* Document Grid */}
            {isLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="pf-card flat" style={{ padding: 16 }}>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-5 w-5 rounded" />
                        <Skeleton className="h-4 w-32" />
                      </div>
                      <Skeleton className="h-4 w-16 rounded-full" />
                    </div>
                    <div className="space-y-2 mb-3">
                      <Skeleton className="h-3 w-40" />
                      <div className="flex items-center justify-between">
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <div
                      className="flex items-center gap-2 pt-2"
                      style={{ borderTop: "1px dashed var(--rule-soft)" }}
                    >
                      <Skeleton className="h-7 w-14 rounded-md" />
                      <Skeleton className="h-7 w-7 rounded-md ml-auto" />
                    </div>
                  </div>
                ))}
              </div>
            ) : documents.length === 0 ? (
              <div className="pf-card flat text-center py-16">
                <FileText className="h-12 w-12 text-[var(--ink-3)] mx-auto mb-3" />
                <p className="text-[var(--ink-3)] text-sm">
                  {searchQuery || categoryFilter !== "ALL"
                    ? "No documents match your filters"
                    : "No documents yet. Upload a file or import from URL to get started."}
                </p>
              </div>
            ) : (
              <>
                {viewMode === "cards" ? (
                  <div
                    className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5"
                    data-walkthrough="documents-grid"
                  >
                    {documents.map((doc) => (
                      <DocumentCard
                        key={doc.id}
                        document={doc}
                        onView={handleView}
                        onDownload={handleDownload}
                        onDelete={isDemoMode ? () => {} : handleDelete}
                        isDeleting={deletingId === doc.id}
                        isDownloading={downloadingId === doc.id}
                      />
                    ))}
                  </div>
                ) : (
                  <div
                    className="pf-card"
                    style={{ padding: 0, overflow: "hidden" }}
                  >
                    {documents.map((doc, i) => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--rule-softer)]"
                        style={
                          i < documents.length - 1
                            ? { borderBottom: "1px dashed var(--rule-soft)" }
                            : undefined
                        }
                      >
                        <FileText
                          className="h-4 w-4 shrink-0"
                          style={{ color: "var(--emerald-text)" }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="mono text-[12.5px] font-bold text-[var(--ink)] truncate">
                            {doc.title}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            <span
                              className="mono text-[9.5px] uppercase tracking-[0.6px] font-bold"
                              style={{ color: "var(--emerald-text)" }}
                            >
                              {doc.category.replace(/_/g, " ")}
                            </span>
                            {doc.processingStatus && (
                              <>
                                <span className="text-[var(--ink-4)]">·</span>
                                <span
                                  className="mono text-[9.5px] uppercase tracking-[0.6px] text-[var(--ink-3)]"
                                  // MONEY-1168: this compact row has no space
                                  // for the sentence, but a bare FAILED with no
                                  // way to find out why is the bug. The card
                                  // shows it inline; here it is on hover.
                                  title={doc.processingError ?? undefined}
                                >
                                  {doc.processingStatus}
                                </span>
                              </>
                            )}
                            <span className="text-[var(--ink-4)]">·</span>
                            <span className="mono text-[10px] text-[var(--ink-3)]">
                              {new Date(doc.createdAt).toLocaleDateString(
                                "en-IN",
                                {
                                  day: "numeric",
                                  month: "short",
                                }
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleView(doc.id)}
                            className="pf-bf sm"
                            title="View"
                          >
                            View
                          </button>
                          <button
                            onClick={() => handleDownload(doc.id)}
                            disabled={downloadingId === doc.id}
                            className="p-1.5 rounded-md text-[var(--ink-3)] hover:text-[var(--emerald-text)] hover:bg-[var(--rule-softer)] transition-colors disabled:opacity-50"
                            title="Download"
                          >
                            {downloadingId === doc.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5" />
                            )}
                          </button>
                          {!isDemoMode && (
                            <button
                              onClick={() => handleDelete(doc.id)}
                              disabled={deletingId === doc.id}
                              className="p-1.5 rounded-md text-[var(--ink-3)] transition-colors disabled:opacity-50 hover:bg-[var(--rule-softer)]"
                              style={{ color: "var(--ink-3)" }}
                              title="Delete"
                            >
                              {deletingId === doc.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Pagination */}
                {total > PAGE_SIZE && (
                  <div className="flex items-center justify-between mt-6">
                    <p className="text-[var(--ink-3)] text-sm">
                      Showing {(page - 1) * PAGE_SIZE + 1}–
                      {Math.min(page * PAGE_SIZE, total)} of {total}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        className="pf-bf sm"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => p - 1)}
                        style={
                          page <= 1
                            ? { opacity: 0.5, cursor: "not-allowed" }
                            : undefined
                        }
                      >
                        <ChevronLeft className="h-4 w-4 mr-1" />
                        Previous
                      </button>
                      <span className="mono text-[var(--ink-3)] text-[12px] px-2">
                        Page {page} of {Math.ceil(total / PAGE_SIZE)}
                      </span>
                      <button
                        className="pf-bf sm"
                        disabled={page * PAGE_SIZE >= total}
                        onClick={() => setPage((p) => p + 1)}
                        style={
                          page * PAGE_SIZE >= total
                            ? { opacity: 0.5, cursor: "not-allowed" }
                            : undefined
                        }
                      >
                        Next
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </PageGuard>
        </div>
      </main>
    </div>
  );
}
