"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertCircle, Trash2, X } from "lucide-react";
import {
  listMembers,
  getMemberDetail,
  setMemberPlan,
  softDeleteMember,
  type MemberRow,
  type MemberDetail,
} from "@/lib/actions/members";

const cell = "px-4 py-2 text-sm align-top";
const head = "px-4 py-2 text-left text-xs font-semibold text-muted-foreground";
const PLANS = ["", "FREE", "PRO", "PREMIUM", "ULTIMATE"];

export function MembersClient() {
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("");
  const [data, setData] = useState<{ rows: MemberRow[]; total: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemberDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await listMembers({
          email: email || undefined,
          plan: plan || undefined,
        }),
      );
    } catch {
      setError("Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [email, plan]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (userId: string) => {
    setDetailLoading(true);
    setError(null);
    try {
      setSelected(await getMemberDetail(userId));
    } catch {
      setError("Failed to load member detail");
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Members</h1>
        <p className="text-muted-foreground mt-1">
          App users — subscription, brokers, payments, and admin actions.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Search by email"
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border bg-background text-sm"
        />
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="px-3 py-2 rounded-lg border bg-background text-sm"
        >
          {PLANS.map((p) => (
            <option key={p || "all"} value={p}>
              {p || "All plans"}
            </option>
          ))}
        </select>
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
              <th className={head}>Joined</th>
              <th className={head}>Email</th>
              <th className={head}>Name</th>
              <th className={head}>Plan</th>
              <th className={head}>Status</th>
              <th className={head}>Brokers</th>
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
              data.rows.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => openDetail(m.id)}
                  className="cursor-pointer hover:bg-accent/50"
                >
                  <td className={cell}>
                    {new Date(m.createdAt).toLocaleDateString()}
                  </td>
                  <td className={cell}>{m.email}</td>
                  <td className={cell}>{m.name ?? "-"}</td>
                  <td className={cell}>{m.planId}</td>
                  <td className={cell}>{m.status}</td>
                  <td className={cell}>{m.brokersConnected}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={cell} colSpan={6}>
                  No members.
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

      {detailLoading && (
        <p className="text-sm text-muted-foreground">Loading detail…</p>
      )}
      {selected && (
        <MemberDetailCard
          member={selected}
          onClose={() => setSelected(null)}
          onChanged={async () => {
            await openDetail(selected.id);
            await load();
          }}
        />
      )}
    </div>
  );
}

function MemberDetailCard({
  member,
  onClose,
  onChanged,
}: {
  member: MemberDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [planSel, setPlanSel] = useState(member.subscription?.planId ?? "FREE");
  const [cycle, setCycle] = useState("monthly");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await setMemberPlan(member.id, planSel, cycle);
      if (!res.success) setErr(res.error ?? "Failed");
      else onChanged();
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (
      !confirm(
        `Queue deletion for ${member.email}? This schedules the account-deletion pipeline (audit snapshot + worker).`,
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await softDeleteMember(member.id, reason);
      if (!res.success) setErr(res.error ?? "Failed");
      else onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{member.email}</h2>
          <p className="text-sm text-muted-foreground">
            {member.name ?? "—"} · joined{" "}
            {new Date(member.createdAt).toLocaleDateString()}
          </p>
        </div>
        <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-2">Subscription</h3>
          {member.subscription ? (
            <ul className="text-sm space-y-1 text-muted-foreground">
              <li>
                Plan:{" "}
                <b className="text-foreground">{member.subscription.planId}</b>{" "}
                · {member.subscription.status}
              </li>
              <li>Cycle: {member.subscription.billingPeriod ?? "—"}</li>
              <li>
                Credits: {member.subscription.creditsUsed}/
                {member.subscription.creditsLimit}
              </li>
              <li>
                Next billing:{" "}
                {member.subscription.nextBillingDate
                  ? new Date(
                      member.subscription.nextBillingDate,
                    ).toLocaleDateString()
                  : "—"}
              </li>
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No subscription row.
            </p>
          )}
          <div className="flex gap-2 mt-3">
            <select
              value={planSel}
              onChange={(e) => setPlanSel(e.target.value)}
              className="px-2 py-1.5 rounded-lg border bg-background text-sm"
            >
              {["FREE", "PRO", "PREMIUM", "ULTIMATE"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={cycle}
              onChange={(e) => setCycle(e.target.value)}
              className="px-2 py-1.5 rounded-lg border bg-background text-sm"
            >
              <option value="monthly">monthly</option>
              <option value="annual">annual</option>
            </select>
            <button
              onClick={apply}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              Set plan
            </button>
          </div>
        </div>

        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-2">
            Brokers ({member.brokers.length})
          </h3>
          {member.brokers.length > 0 ? (
            <ul className="text-sm space-y-1 text-muted-foreground">
              {member.brokers.map((b, i) => (
                <li key={i}>
                  {b.broker} · {b.status}
                  {b.lastSync
                    ? ` · synced ${new Date(b.lastSync).toLocaleDateString()}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No brokers connected.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold mb-2">Recent payments</h3>
        {member.payments.length > 0 ? (
          <ul className="text-sm space-y-1 text-muted-foreground">
            {member.payments.map((p) => (
              <li key={p.id}>
                {new Date(p.createdAt).toLocaleDateString()} · {p.planName} · ₹
                {p.amount} · {p.status}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No payments.</p>
        )}
      </div>

      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
        <h3 className="text-sm font-semibold mb-2 text-red-400">Danger zone</h3>
        <div className="flex flex-wrap gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border bg-background text-sm"
          />
          <button
            onClick={del}
            disabled={busy}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-red-500/40 text-red-400 text-sm hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Queue deletion
          </button>
        </div>
      </div>
    </div>
  );
}
