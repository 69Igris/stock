"use client";

import {
  FileText,
  Image,
  FileSpreadsheet,
  File,
  Download,
  Trash2,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { buildDocResearchPinUrl } from "../doc-research-pin";

interface DocumentCardProps {
  document: {
    id: string;
    title: string;
    description: string | null;
    sourceType: string;
    documentType: string;
    category: string;
    fileName: string;
    fileSize: number;
    processingStatus: string;
    /**
     * MONEY-1168: one sanitised sentence explaining a FAILED status. Optional
     * because rows that failed before the field existed have none, and because
     * other callers of this card may not select it — a missing reason must
     * degrade to today's bare badge, never to a crash or an empty callout.
     */
    processingError?: string | null;
    createdAt: Date;
  };
  onView: (id: string) => void;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  isDeleting: boolean;
  isDownloading: boolean;
}

const FILE_TYPE_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  PDF: FileText,
  IMAGE: Image,
  CSV: FileSpreadsheet,
  SPREADSHEET: FileSpreadsheet,
  REPORT: FileText,
};

const CATEGORY_LABELS: Record<string, string> = {
  BROKER_STATEMENT: "Broker Statement",
  CONTRACT_NOTE: "Contract Note",
  ANNUAL_REPORT: "Annual Report",
  RESEARCH_REPORT: "Research List",
  TAX_REPORT: "Tax Report",
  RISK_REPORT: "Risk Report",
  PORTFOLIO_STATEMENT: "Portfolio",
  OTHER: "Other",
};

// Tilted-icon chip background per category, mapped to playful pop tokens.
const CATEGORY_ICON_COLOR: Record<string, string> = {
  BROKER_STATEMENT: "var(--pop-3)",
  CONTRACT_NOTE: "var(--pop-5)",
  ANNUAL_REPORT: "var(--emerald)",
  RESEARCH_REPORT: "var(--pop-2)",
  TAX_REPORT: "var(--pop-1)",
  RISK_REPORT: "var(--pop-1)",
  PORTFOLIO_STATEMENT: "var(--pop-3)",
  OTHER: "var(--ink-3)",
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function ProcessingStatusIndicator({ status }: { status: string }) {
  // Per DocumentVault.jsx: tinted dot + uppercase mono label inside pill
  const cfg: Record<
    string,
    { label: string; bg: string; fg: string; dot: string; pulse: boolean }
  > = {
    PENDING: {
      label: "QUEUED",
      bg: "rgba(148,163,184,.1)",
      fg: "#94a3b8",
      dot: "#94a3b8",
      pulse: false,
    },
    PROCESSING: {
      label: "EXTRACTING",
      bg: "rgba(34,211,238,.1)",
      fg: "#22d3ee",
      dot: "#22d3ee",
      pulse: true,
    },
    READY: {
      label: "INDEXED",
      bg: "rgba(52,211,153,.1)",
      fg: "#34d399",
      dot: "#34d399",
      pulse: false,
    },
    FAILED: {
      label: "FAILED",
      bg: "rgba(248,113,113,.1)",
      fg: "#f87171",
      dot: "#f87171",
      pulse: false,
    },
  };
  const t = cfg[status];
  if (!t) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-mono text-[10px] font-bold tracking-[0.3px] border"
      style={{
        background: t.bg,
        color: t.fg,
        borderColor: `${t.dot}30`,
      }}
    >
      <span
        className="w-[5px] h-[5px] rounded-full"
        style={{
          background: t.dot,
          boxShadow: `0 0 4px ${t.dot}`,
          animation: t.pulse ? "ph-pulse 1.5s ease-in-out infinite" : "none",
        }}
      />
      {t.label}
    </span>
  );
}

export function DocumentCard({
  document: doc,
  onView,
  onDownload,
  onDelete,
  isDeleting,
  isDownloading,
}: DocumentCardProps) {
  const Icon = FILE_TYPE_ICONS[doc.documentType] || File;
  const categoryLabel = CATEGORY_LABELS[doc.category] || doc.category;
  const iconColor =
    CATEGORY_ICON_COLOR[doc.category] || CATEGORY_ICON_COLOR.OTHER;
  const router = useRouter();
  // MONEY-1074: the primary card action ALWAYS opens StockSage (chat) with the
  // document pinned as research context. It was previously gated behind an
  // off-by-default flag whose OFF branch ran `onView` — which opens the signed
  // file URL — so "Ask StockSage" downloaded the file instead of chatting. The
  // viewer stays reachable via the clickable title below.
  const handleAskStockSage = () => {
    router.push(buildDocResearchPinUrl(doc));
  };

  const isReady = doc.processingStatus === "READY";

  return (
    <div
      className="pf-card flex flex-col gap-2.5 min-h-[160px]"
      style={{ padding: 16 }}
    >
      <div className="flex items-start gap-2.5">
        <div
          className="w-10 h-10 rounded-md flex items-center justify-center flex-shrink-0"
          style={{
            background: iconColor,
            color: "var(--paper)",
            border: "1.5px solid var(--ink)",
            transform: "rotate(-3deg)",
          }}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          {/* MONEY-1074 + MONEY-1075: the title is the "open document" affordance
              (the primary button now routes to StockSage) AND clamps to 2 lines +
              wraps so a long storage-key filename can't blow out the card; the
              tooltips reveal the full title / filename on hover. */}
          <button
            type="button"
            onClick={() => onView(doc.id)}
            disabled={!isReady}
            title={isReady ? doc.title : "Document is still processing"}
            className="text-left w-full text-[12.5px] font-bold text-[var(--ink)] leading-[1.35] line-clamp-2 break-words hover:underline disabled:no-underline"
            style={{ cursor: isReady ? "pointer" : "default" }}
          >
            {doc.title}
          </button>
          <p
            className="mono text-[11px] text-[var(--ink-3)] mt-0.5 truncate"
            title={doc.fileName}
          >
            {doc.fileName}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <ProcessingStatusIndicator status={doc.processingStatus} />
        <span className="pf-pill outline" style={{ fontSize: 9.5 }}>
          {categoryLabel}
        </span>
      </div>

      {/*
        MONEY-1168: say WHY it failed. Rendered only when there is a reason, so
        a row that failed before the field existed keeps today's bare badge
        instead of showing an empty callout. The string is sanitised at the
        point it is written (`describeDocumentFailure`), so it is safe verbatim.
      */}
      {doc.processingStatus === "FAILED" && doc.processingError ? (
        <p
          className="text-[10.5px] leading-[1.45] text-[#f87171] rounded px-2 py-1.5"
          style={{
            background: "rgba(248,113,113,.08)",
            border: "1px solid rgba(248,113,113,.2)",
          }}
          title={doc.processingError}
        >
          {doc.processingError}
        </p>
      ) : null}

      <div className="flex-1" />

      <div
        className="flex justify-between items-center mono text-[10px] text-[var(--ink-3)] pt-2"
        style={{ borderTop: "1px dashed var(--rule-soft)" }}
      >
        <span>{formatDate(doc.createdAt)}</span>
        <span>{formatFileSize(doc.fileSize)}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          className="pf-bs sm flex-1 justify-center"
          onClick={handleAskStockSage}
          disabled={!isReady}
          style={!isReady ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          title="Ask StockSage about this document"
        >
          <Sparkles className="h-2.5 w-2.5" />
          Ask StockSage
        </button>
        <button
          className="pf-bf sm"
          style={{
            padding: 5,
            ...(!isReady || isDownloading
              ? { opacity: 0.5, cursor: "not-allowed" }
              : {}),
          }}
          onClick={() => onDownload(doc.id)}
          disabled={!isReady || isDownloading}
          title="Download"
        >
          {isDownloading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
        </button>
        <button
          className="pf-bf sm danger"
          style={{
            padding: 5,
            ...(isDeleting ? { opacity: 0.5, cursor: "not-allowed" } : {}),
          }}
          onClick={() => onDelete(doc.id)}
          disabled={isDeleting}
          title="Delete"
        >
          {isDeleting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </button>
      </div>
    </div>
  );
}
