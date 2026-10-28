"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertCircle, ExternalLink, CheckCircle2 } from "lucide-react";
import {
  listPayments,
  markPaymentComplete,
  type PaymentRow,
} from "@/lib/actions/payments";

const cell = "px-4 py-2 text-sm align-top";
const head = "px-4 py-2 text-left text-xs font-semibold text-muted-foreground";
const STATUSES = ["", "PENDING", "COMPLETED", "FAILED"];
const BASE_PLANS = new Set(["PRO", "PREMIUM", "ULTIMATE"]);

export function PaymentsClient() {
  const [status, setStatus] = useState("");
  const [email, setEmail] = useState("");
  const [data, setData] = useState<{
    rows: PaymentRow[];
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await listPayments({
          status: status || undefined,
          email: email || undefined,
        }),
      );
    } catch {
      setError("Failed to load payments");
    } finally {
      setLoading(false);
    }
  }, [status, email]);

  useEffect(() => {
    load();
  }, [load]);

  const onMarkComplete = async (id: string) => {
    if (
      !confirm(
        "Mark this payment COMPLETED and grant the plan? Use only for a stuck payment after a webhook outage.",
      )
    )
      return;
    setBusyId(id);
    setError(null);
    try {
      const res = await markPaymentComplete(id);
      if (!res.success) setError(res.error ?? "Failed");
      else await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Payments</h1>
        <p className="text-muted-foreground mt-1">
          Subscription payments. Manually complete a stuck base-plan payment;
          refunds are issued in the Dodo dashboard.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s || "all"}
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-lg border text-sm ${
              status === s
                ? "border-primary bg-primary/10 text-primary"
                : "hover:bg-muted"
            }`}
          >
            {s || "All"}
          </button>
        ))}
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Filter by user email"
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border bg-background text-sm"
        />
        <button onClick={load} className="px-3 py-2 rounded-lg border text-sm">
          Search
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full">
          <thead className="border-b">
            <tr>
              <th className={head}>Time</th>
              <th className={head}>User</th>
              <th className={head}>Plan</th>
              <th className={head}>Amount</th>
              <th className={head}>Status</th>
              <th className={head}>Dodo</th>
              <th className={head}>Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td className={cell} colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : data && data.rows.length > 0 ? (
              data.rows.map((p) => (
                <tr key={p.id}>
                  <td className={cell}>
                    {new Date(p.createdAt).toLocaleString()}
                  </td>
                  <td className={cell}>{p.userEmail}</td>
                  <td className={cell}>
                    {p.planName}
                    <span className="text-muted-foreground"> · {p.period}</span>
                  </td>
                  <td className={cell}>
                    {p.currency} {p.amount}
                  </td>
                  <td className={cell}>
                    <span
                      className={
                        p.status === "FAILED"
                          ? "text-red-400"
                          : p.status === "PENDING"
                            ? "text-yellow-400"
                            : "text-emerald-400"
                      }
                    >
                      {p.status}
                    </span>
                    {p.appliedAt && (
                      <span className="text-muted-foreground text-xs block">
                        applied
                      </span>
                    )}
                  </td>
                  <td className={cell}>
                    {p.invoiceUrl ? (
                      <a
                        href={p.invoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary text-xs"
                      >
                        Invoice <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-xs font-mono">
                        {p.dodoPaymentId?.slice(0, 14) ?? "-"}
                      </span>
                    )}
                  </td>
                  <td className={cell}>
                    {p.status === "PENDING" && BASE_PLANS.has(p.planId) ? (
                      <button
                        onClick={() => onMarkComplete(p.id)}
                        disabled={busyId === p.id}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-xs hover:bg-muted disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        {busyId === p.id ? "…" : "Complete"}
                      </button>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={cell} colSpan={7}>
                  No payments.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && (
        <p className="text-xs text-muted-foreground">
          Showing {data.rows.length} of {data.total}
        </p>
      )}
    </div>
  );
}
