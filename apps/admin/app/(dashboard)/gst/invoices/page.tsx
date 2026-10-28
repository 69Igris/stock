"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Receipt,
  Loader2,
  Download,
  AlertCircle,
  Upload,
  X,
  FileText,
  Ban,
  RefreshCw,
} from "lucide-react";
import {
  listGstInvoicesAction,
  getGstInvoiceDownloadUrlAction,
  ingestDodoCsvAction,
  listPendingPayoutGroupsAction,
  generateInvoicesFromPayoutAction,
  cancelGstInvoiceAction,
  type InvoiceListItem,
} from "@/lib/actions/gst";

const STATUSES = ["ALL", "DRAFT", "ISSUED", "CANCELLED"] as const;
const CURRENCIES = ["ALL", "USD", "GBP", "EUR", "INR"] as const;

interface PendingGroup {
  billingPeriodStart: string;
  billingPeriodEnd: string;
  currency: string;
  rowCount: number;
  netAmount: number;
  grossAmount: number;
}

export default function GstInvoicesPage() {
  const [items, setItems] = useState<InvoiceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("ALL");
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>("ALL");
  const [search, setSearch] = useState("");

  // Generate-from-payout drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingGroups, setPendingGroups] = useState<PendingGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationLog, setGenerationLog] = useState<
    Array<{
      currency: string;
      period: string;
      status: string;
      invoiceNumber?: string;
      error?: string;
    }>
  >([]);

  // CSV upload
  const [csvText, setCsvText] = useState("");
  const [uploadResult, setUploadResult] = useState<string | null>(null);

  // Cancel modal
  const [cancelTarget, setCancelTarget] = useState<InvoiceListItem | null>(
    null,
  );
  const [cancelReason, setCancelReason] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listGstInvoicesAction({
      status: status === "ALL" ? undefined : status,
      currency: currency === "ALL" ? undefined : currency,
      search: search.trim() || undefined,
      page,
      pageSize,
    });
    if (!res.success) {
      setError(res.error);
      setItems([]);
      setTotal(0);
    } else {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [status, currency, search, page, pageSize]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadPendingGroups = useCallback(async () => {
    setGroupsLoading(true);
    const res = await listPendingPayoutGroupsAction();
    if (res.success) {
      setPendingGroups(
        res.data.map((g) => ({
          billingPeriodStart: g.billingPeriodStart.toISOString(),
          billingPeriodEnd: g.billingPeriodEnd.toISOString(),
          currency: g.currency,
          rowCount: g.rowCount,
          netAmount: g.netAmount,
          grossAmount: g.grossAmount,
        })),
      );
    }
    setGroupsLoading(false);
  }, []);

  const openDrawer = () => {
    setDrawerOpen(true);
    setUploadResult(null);
    setGenerationLog([]);
    void loadPendingGroups();
  };

  const handleCsvUpload = async () => {
    if (!csvText.trim()) return;
    setUploadResult(null);
    const res = await ingestDodoCsvAction({ csvText });
    if (!res.success) {
      setUploadResult(`Error: ${res.error}`);
      return;
    }
    const { inserted, skippedDuplicates, alreadyIngested } = res.data;
    setUploadResult(
      alreadyIngested
        ? "Already ingested - no new rows"
        : `Inserted ${inserted} rows, skipped ${skippedDuplicates} duplicates`,
    );
    setCsvText("");
    await loadPendingGroups();
  };

  const handleGenerate = async () => {
    if (pendingGroups.length === 0) return;
    setGenerating(true);
    setGenerationLog([]);
    const res = await generateInvoicesFromPayoutAction({
      groups: pendingGroups.map((g) => ({
        billingPeriodStart: g.billingPeriodStart,
        billingPeriodEnd: g.billingPeriodEnd,
        currency: g.currency,
      })),
    });
    setGenerationLog(
      res.data.map((r) => ({
        currency: r.currency,
        period: `${r.billingPeriodStart.slice(0, 10)} → ${r.billingPeriodEnd.slice(0, 10)}`,
        status: r.status,
        invoiceNumber: r.invoiceNumber,
        error: r.error,
      })),
    );
    setGenerating(false);
    await refresh();
    await loadPendingGroups();
  };

  const handleDownload = async (invoiceId: string) => {
    const res = await getGstInvoiceDownloadUrlAction(invoiceId);
    if (!res.success) {
      alert(res.error);
      return;
    }
    window.open(res.data.url, "_blank", "noopener,noreferrer");
  };

  const handleCancel = async () => {
    if (!cancelTarget || !cancelReason.trim()) return;
    const res = await cancelGstInvoiceAction({
      invoiceId: cancelTarget.id,
      reason: cancelReason.trim(),
    });
    if (!res.success) {
      alert(res.error);
      return;
    }
    setCancelTarget(null);
    setCancelReason("");
    await refresh();
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Receipt className="h-6 w-6 text-emerald-400" />
            GST Invoices
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Export-of-services invoices under LUT - UMAI/EXP/YY-YY/NNNN
          </p>
        </div>
        <button
          type="button"
          onClick={openDrawer}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          <Upload className="h-4 w-4" />
          Generate from payout
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as (typeof STATUSES)[number]);
            setPage(1);
          }}
          className="rounded-md bg-slate-800 px-3 py-2 text-sm text-white border border-slate-700"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "ALL" ? "All statuses" : s}
            </option>
          ))}
        </select>
        <select
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value as (typeof CURRENCIES)[number]);
            setPage(1);
          }}
          className="rounded-md bg-slate-800 px-3 py-2 text-sm text-white border border-slate-700"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c === "ALL" ? "All currencies" : c}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search invoice number"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="flex-1 min-w-[200px] rounded-md bg-slate-800 px-3 py-2 text-sm text-white border border-slate-700"
        />
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-2 rounded-md bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-6 text-red-400">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            No invoices match the current filters.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-800/60 text-left">
              <tr>
                <th className="px-3 py-2 font-medium text-slate-300">
                  Invoice #
                </th>
                <th className="px-3 py-2 font-medium text-slate-300">Date</th>
                <th className="px-3 py-2 font-medium text-slate-300">Buyer</th>
                <th className="px-3 py-2 font-medium text-slate-300">CCY</th>
                <th className="px-3 py-2 font-medium text-slate-300 text-right">
                  Amount
                </th>
                <th className="px-3 py-2 font-medium text-slate-300 text-right">
                  INR
                </th>
                <th className="px-3 py-2 font-medium text-slate-300">Status</th>
                <th className="px-3 py-2 font-medium text-slate-300 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-800/30">
                  <td className="px-3 py-2 font-mono text-xs text-white">
                    {item.invoiceNumber}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {item.invoiceDate.toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {item.customerName}{" "}
                    <span className="text-slate-500">·</span>{" "}
                    <span className="text-xs text-slate-500">
                      {item.customerCountry}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">
                    {item.currencyCode}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">
                    {item.subtotalForeign.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-white">
                    ₹
                    {item.totalInr.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={item.status} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        onClick={() => void handleDownload(item.id)}
                        disabled={!item.pdfStorageKey}
                        title={
                          item.pdfStorageKey
                            ? "Download PDF"
                            : "PDF not available"
                        }
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setCancelTarget(item)}
                        disabled={item.status !== "ISSUED"}
                        title={
                          item.status === "ISSUED"
                            ? "Cancel invoice"
                            : "Already cancelled or draft"
                        }
                        className="rounded p-1.5 text-slate-400 hover:bg-red-900/40 hover:text-red-300 disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        <Ban className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {!loading && total > pageSize && (
          <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
            <span>
              Page {page} of {totalPages} · {total} invoices
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded bg-slate-800 px-3 py-1 hover:bg-slate-700 disabled:opacity-30"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="rounded bg-slate-800 px-3 py-1 hover:bg-slate-700 disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Generate-from-payout drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            className="absolute right-0 top-0 h-full w-full max-w-2xl overflow-y-auto bg-slate-900 border-l border-slate-800 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">
                Generate invoices from payout
              </h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Step 1: Upload */}
            <div className="space-y-2 mb-6">
              <h3 className="text-sm font-medium text-slate-300">
                1. Paste DodoPayments wallet ledger CSV
              </h3>
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="transaction_id,payout_id,transaction_date,..."
                rows={6}
                className="w-full rounded-md bg-slate-800 px-3 py-2 text-xs font-mono text-white border border-slate-700"
              />
              <button
                type="button"
                onClick={() => void handleCsvUpload()}
                disabled={!csvText.trim()}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-30"
              >
                Upload CSV
              </button>
              {uploadResult && (
                <p className="text-xs text-slate-400">{uploadResult}</p>
              )}
            </div>

            {/* Step 2: Pending groups preview */}
            <div className="space-y-2 mb-6">
              <h3 className="text-sm font-medium text-slate-300">
                2. Preview pending invoices
              </h3>
              {groupsLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              ) : pendingGroups.length === 0 ? (
                <p className="text-xs text-slate-500">No pending groups.</p>
              ) : (
                <div className="rounded-md border border-slate-800 bg-slate-800/30">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-800/60 text-left">
                      <tr>
                        <th className="px-2 py-1.5 text-slate-400">Period</th>
                        <th className="px-2 py-1.5 text-slate-400">CCY</th>
                        <th className="px-2 py-1.5 text-slate-400 text-right">
                          Rows
                        </th>
                        <th className="px-2 py-1.5 text-slate-400 text-right">
                          Net
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingGroups.map((g, i) => (
                        <tr key={i} className="border-t border-slate-800">
                          <td className="px-2 py-1.5 text-slate-300">
                            {g.billingPeriodStart.slice(0, 10)} →{" "}
                            {g.billingPeriodEnd.slice(0, 10)}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-slate-300">
                            {g.currency}
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-300">
                            {g.rowCount}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-slate-300">
                            {g.netAmount.toLocaleString("en-IN", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Step 3: Generate */}
            <div className="space-y-2 mb-6">
              <h3 className="text-sm font-medium text-slate-300">
                3. Confirm generation
              </h3>
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={generating || pendingGroups.length === 0}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-30 inline-flex items-center gap-2"
              >
                {generating && <Loader2 className="h-4 w-4 animate-spin" />}
                Generate {pendingGroups.length} invoice
                {pendingGroups.length === 1 ? "" : "s"}
              </button>
            </div>

            {/* Generation log */}
            {generationLog.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium text-slate-300">Result</h3>
                <ul className="space-y-1 text-xs">
                  {generationLog.map((r, i) => (
                    <li
                      key={i}
                      className="rounded bg-slate-800/50 px-2 py-1.5 flex items-start gap-2"
                    >
                      <FileText className="h-3.5 w-3.5 text-slate-500 mt-0.5 flex-shrink-0" />
                      <div>
                        <div>
                          <span className="font-mono text-slate-300">
                            {r.currency}
                          </span>{" "}
                          {r.period} →{" "}
                          <span
                            className={
                              r.status === "issued"
                                ? "text-emerald-400"
                                : r.status === "credit_note"
                                  ? "text-blue-400"
                                  : "text-red-400"
                            }
                          >
                            {r.status}
                          </span>{" "}
                          {r.invoiceNumber && (
                            <span className="font-mono text-slate-400">
                              {r.invoiceNumber}
                            </span>
                          )}
                        </div>
                        {r.error && (
                          <div className="text-red-400 mt-0.5">{r.error}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cancel modal */}
      {cancelTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => {
            setCancelTarget(null);
            setCancelReason("");
          }}
        >
          <div
            className="w-full max-w-md rounded-lg bg-slate-900 border border-slate-800 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white mb-2">
              Cancel invoice
            </h2>
            <p className="text-sm text-slate-400 mb-4">
              <span className="font-mono">{cancelTarget.invoiceNumber}</span> -
              the number is preserved with status CANCELLED for audit. This is
              irreversible.
            </p>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason (required for audit)"
              rows={3}
              className="w-full rounded-md bg-slate-800 px-3 py-2 text-sm text-white border border-slate-700 mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCancelTarget(null);
                  setCancelReason("");
                }}
                className="rounded-md bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600"
              >
                Keep invoice
              </button>
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={!cancelReason.trim()}
                className="rounded-md bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-500 disabled:opacity-30"
              >
                Cancel invoice
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    DRAFT: {
      label: "Draft",
      className: "bg-amber-900/40 text-amber-300 border-amber-800",
    },
    ISSUED: {
      label: "Issued",
      className: "bg-emerald-900/40 text-emerald-300 border-emerald-800",
    },
    CANCELLED: {
      label: "Cancelled",
      className: "bg-red-900/40 text-red-300 border-red-800",
    },
  };
  const c = config[status] ?? {
    label: status,
    className: "bg-slate-800 text-slate-300 border-slate-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${c.className}`}
    >
      {c.label}
    </span>
  );
}
