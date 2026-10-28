"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertCircle, Download, RefreshCw } from "lucide-react";
import {
  getBrokerFailures,
  getConsentRecords,
  getConsentExport,
  getSyncLogs,
  type BrokerFailureRow,
  type ConsentRow,
  type SyncLogRow,
} from "@/lib/actions/audit-logs";

type Tab = "failures" | "consent" | "sync";

const TABS: { id: Tab; label: string }[] = [
  { id: "failures", label: "Broker Failures" },
  { id: "consent", label: "Consent Records" },
  { id: "sync", label: "Sync Logs" },
];

const cell = "px-4 py-2 text-sm align-top";
const head = "px-4 py-2 text-left text-xs font-semibold text-muted-foreground";

export function AuditLogsClient() {
  const [tab, setTab] = useState<Tab>("failures");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Audit Logs</h1>
        <p className="text-muted-foreground mt-1">
          Broker integration failures, SEBI consent records, and sync history.
        </p>
      </div>

      <div className="flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "failures" && <BrokerFailuresTab />}
      {tab === "consent" && <ConsentTab />}
      {tab === "sync" && <SyncLogsTab />}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />
      {message}
    </div>
  );
}

function BrokerFailuresTab() {
  const [errorClass, setErrorClass] = useState("");
  const [broker, setBroker] = useState("");
  const [data, setData] = useState<{
    rows: BrokerFailureRow[];
    total: number;
    summary: { errorClass: string; count: number }[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await getBrokerFailures({
          errorClass: errorClass || undefined,
          broker: broker || undefined,
        }),
      );
    } catch {
      setError("Failed to load broker failures");
    } finally {
      setLoading(false);
    }
  }, [errorClass, broker]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      {data && data.summary.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.summary.map((s) => (
            <button
              key={s.errorClass}
              onClick={() =>
                setErrorClass(errorClass === s.errorClass ? "" : s.errorClass)
              }
              className={`px-3 py-1 rounded-full text-xs border ${
                errorClass === s.errorClass
                  ? "border-primary bg-primary/10 text-primary"
                  : "hover:bg-muted"
              }`}
            >
              {s.errorClass} · {s.count}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={broker}
          onChange={(e) => setBroker(e.target.value.toUpperCase())}
          placeholder="Broker (e.g. ZERODHA)"
          className="px-3 py-2 rounded-lg border bg-background text-sm"
        />
        <button onClick={load} className="px-3 py-2 rounded-lg border text-sm">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full">
          <thead className="border-b">
            <tr>
              <th className={head}>Time</th>
              <th className={head}>Broker</th>
              <th className={head}>Operation</th>
              <th className={head}>Error Class</th>
              <th className={head}>Message</th>
              <th className={head}>User (hash)</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td className={cell} colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : data && data.rows.length > 0 ? (
              data.rows.map((r) => (
                <tr key={r.id}>
                  <td className={cell}>
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className={cell}>{r.broker}</td>
                  <td className={cell}>{r.operation}</td>
                  <td className={cell}>
                    {r.errorClass}
                    {r.errorCode ? ` (${r.errorCode})` : ""}
                  </td>
                  <td className={cell}>{r.userFacingMessage}</td>
                  <td className={`${cell} font-mono text-xs`}>
                    {r.userIdHash.slice(0, 12)}…
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={cell} colSpan={6}>
                  No failures.
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

function ConsentTab() {
  const [email, setEmail] = useState("");
  const [data, setData] = useState<{
    rows: ConsentRow[];
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getConsentRecords({ userEmail: email || undefined }));
    } catch {
      setError("Failed to load consent records");
    } finally {
      setLoading(false);
    }
  }, [email]);

  useEffect(() => {
    load();
  }, [load]);

  const exportConsent = async (format: "csv" | "json") => {
    if (!email) {
      setError("Enter a user email to export their consent records");
      return;
    }
    try {
      const { filename, content } = await getConsentExport(email, format);
      const blob = new Blob([content], {
        type: format === "json" ? "application/json" : "text/csv",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Filter by user email (required for export)"
          className="flex-1 min-w-[220px] px-3 py-2 rounded-lg border bg-background text-sm"
        />
        <button onClick={load} className="px-3 py-2 rounded-lg border text-sm">
          Search
        </button>
        <button
          onClick={() => exportConsent("csv")}
          className="flex items-center gap-1 px-3 py-2 rounded-lg border text-sm"
        >
          <Download className="h-4 w-4" /> CSV
        </button>
        <button
          onClick={() => exportConsent("json")}
          className="flex items-center gap-1 px-3 py-2 rounded-lg border text-sm"
        >
          <Download className="h-4 w-4" /> JSON
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full">
          <thead className="border-b">
            <tr>
              <th className={head}>Accepted</th>
              <th className={head}>User</th>
              <th className={head}>Kind</th>
              <th className={head}>Version</th>
              <th className={head}>Source</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td className={cell} colSpan={5}>
                  Loading…
                </td>
              </tr>
            ) : data && data.rows.length > 0 ? (
              data.rows.map((r) => (
                <tr key={r.id}>
                  <td className={cell}>
                    {new Date(r.acceptedAt).toLocaleString()}
                  </td>
                  <td className={cell}>{r.userEmail}</td>
                  <td className={cell}>{r.kind}</td>
                  <td className={cell}>{r.version}</td>
                  <td className={cell}>{r.source ?? "-"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={cell} colSpan={5}>
                  No consent records.
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

function SyncLogsTab() {
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{
    rows: SyncLogRow[];
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getSyncLogs({ status: status || undefined }));
    } catch {
      setError("Failed to load sync logs");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {["", "SUCCESS", "FAILED", "PARTIAL"].map((s) => (
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
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full">
          <thead className="border-b">
            <tr>
              <th className={head}>Time</th>
              <th className={head}>User</th>
              <th className={head}>Broker</th>
              <th className={head}>Type</th>
              <th className={head}>Status</th>
              <th className={head}>F/U/C</th>
              <th className={head}>Error</th>
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
              data.rows.map((r) => (
                <tr key={r.id}>
                  <td className={cell}>
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className={cell}>{r.userEmail}</td>
                  <td className={cell}>{r.broker}</td>
                  <td className={cell}>{r.syncType}</td>
                  <td className={cell}>
                    <span
                      className={
                        r.status === "FAILED"
                          ? "text-red-400"
                          : r.status === "PARTIAL"
                            ? "text-yellow-400"
                            : "text-emerald-400"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className={cell}>
                    {r.recordsFetched}/{r.recordsUpdated}/{r.recordsCreated}
                  </td>
                  <td className={cell}>{r.errorMessage ?? "-"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={cell} colSpan={7}>
                  No sync logs.
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
