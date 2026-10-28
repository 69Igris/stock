"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Link2,
  Plus,
  Copy,
  ToggleLeft,
  ToggleRight,
  Loader2,
  AlertCircle,
  Check,
} from "lucide-react";
import {
  getInviteTokens,
  createInviteToken,
  toggleInviteToken,
} from "@/lib/actions/invites";
import type { InviteTokenData } from "@/lib/actions/invites";

const PLAN_OPTIONS = [
  { value: "PRO", label: "Pro" },
  { value: "PREMIUM", label: "Premium" },
  { value: "ULTIMATE", label: "Ultimate" },
];

export default function InvitesPage() {
  const [tokens, setTokens] = useState<InviteTokenData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Form state
  const [formPlanId, setFormPlanId] = useState("PRO");
  const [formMaxUses, setFormMaxUses] = useState("10");
  const [formAssignedTo, setFormAssignedTo] = useState("");
  const [formExpiresAt, setFormExpiresAt] = useState("");
  const [formDiscountCode, setFormDiscountCode] = useState("");

  const fetchTokens = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getInviteTokens();
      setTokens(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load invite tokens",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setCreating(true);
      setError(null);

      const maxUses = parseInt(formMaxUses, 10);
      if (isNaN(maxUses) || maxUses === 0) {
        setError("Max uses must be a number (-1 for unlimited, or positive)");
        return;
      }

      const newToken = await createInviteToken({
        planId: formPlanId,
        maxUses,
        assignedTo: formAssignedTo || undefined,
        expiresAt: formExpiresAt || undefined,
        discountCode: formDiscountCode || undefined,
      });

      setTokens((prev) => [newToken, ...prev]);
      setShowCreate(false);
      setFormPlanId("PRO");
      setFormMaxUses("10");
      setFormAssignedTo("");
      setFormExpiresAt("");
      setFormDiscountCode("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create invite token",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (id: string) => {
    try {
      setToggling(id);
      await toggleInviteToken(id);
      setTokens((prev) =>
        prev.map((t) => (t.id === id ? { ...t, isActive: !t.isActive } : t)),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to toggle invite token",
      );
    } finally {
      setToggling(null);
    }
  };

  const copyLink = (token: string) => {
    const baseUrl = process.env.NEXT_PUBLIC_WEB_URL || "https://usemoney.ai";
    navigator.clipboard.writeText(`${baseUrl}/invite/${token}`);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Invite Links</h1>
          <p className="text-muted-foreground mt-1">
            Create shareable invite links with optional discounts
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Create Invite
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold mb-4">New Invite Link</h2>
          <form onSubmit={handleCreate} className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Plan
              </label>
              <select
                value={formPlanId}
                onChange={(e) => setFormPlanId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm"
              >
                {PLAN_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Max Uses (-1 for unlimited)
              </label>
              <input
                type="number"
                value={formMaxUses}
                onChange={(e) => setFormMaxUses(e.target.value)}
                required
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Assigned To (optional email)
              </label>
              <input
                type="email"
                value={formAssignedTo}
                onChange={(e) => setFormAssignedTo(e.target.value)}
                placeholder="specific-user@email.com"
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Expires At (optional)
              </label>
              <input
                type="datetime-local"
                value={formExpiresAt}
                onChange={(e) => setFormExpiresAt(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Discount Code (optional, from Dodo)
              </label>
              <input
                type="text"
                value={formDiscountCode}
                onChange={(e) =>
                  setFormDiscountCode(e.target.value.toUpperCase())
                }
                placeholder="e.g. LAUNCH20"
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm"
              />
            </div>
            <div className="flex items-end">
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 rounded-lg border hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Tokens Table */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center gap-3 p-6 border-b">
          <div className="p-2 rounded-lg bg-primary/10">
            <Link2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Invite Tokens</h2>
            <p className="text-sm text-muted-foreground">
              {tokens.length} total tokens
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Link2 className="h-8 w-8 mx-auto mb-3 opacity-50" />
            <p>No invite tokens yet</p>
            <p className="text-sm mt-1">Create one to share with users</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Token
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Plan
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Discount
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Usage
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Assigned To
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Expires
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Status
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => {
                  const isExpired =
                    t.expiresAt && new Date(t.expiresAt) < new Date();
                  const isMaxedOut =
                    t.maxUses !== -1 && t.usedCount >= t.maxUses;

                  return (
                    <tr key={t.id} className="border-b last:border-0">
                      <td className="px-6 py-4">
                        <code className="px-2 py-1 rounded bg-muted text-sm font-mono">
                          {t.token}
                        </code>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400">
                          {t.planId}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {t.discountCode || "-"}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        {t.usedCount} / {t.maxUses === -1 ? "∞" : t.maxUses}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {t.assignedTo || "Anyone"}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {t.expiresAt
                          ? new Date(t.expiresAt).toLocaleDateString()
                          : "Never"}
                      </td>
                      <td className="px-6 py-4">
                        {!t.isActive ? (
                          <span className="text-xs text-red-400">Disabled</span>
                        ) : isExpired ? (
                          <span className="text-xs text-yellow-400">
                            Expired
                          </span>
                        ) : isMaxedOut ? (
                          <span className="text-xs text-yellow-400">
                            Maxed Out
                          </span>
                        ) : (
                          <span className="text-xs text-green-400">Active</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => copyLink(t.token)}
                            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                            title="Copy invite link"
                          >
                            {copied === t.token ? (
                              <Check className="h-4 w-4 text-green-400" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            onClick={() => handleToggle(t.id)}
                            disabled={toggling === t.id}
                            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                            title={t.isActive ? "Disable" : "Enable"}
                          >
                            {toggling === t.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : t.isActive ? (
                              <ToggleRight className="h-4 w-4 text-green-400" />
                            ) : (
                              <ToggleLeft className="h-4 w-4 text-red-400" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
