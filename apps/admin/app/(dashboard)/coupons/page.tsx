"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import {
  Tag,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  User,
  Users,
  Pause,
  Play,
  Pencil,
} from "lucide-react";
import {
  listCoupons,
  createCoupon,
  updateCoupon,
  setCouponActive,
  deleteCoupon,
  getCouponUsage,
} from "@/lib/actions/discounts";
import type { CouponData, CouponRedemptionData } from "@/lib/actions/discounts";

export default function CouponsPage() {
  const [coupons, setCoupons] = useState<CouponData[]>([]);
  const [configured, setConfigured] = useState(true);
  const [mode, setMode] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // The coupon pending delete-confirmation — drives a proper modal instead of the
  // native window.confirm().
  const [confirmDelete, setConfirmDelete] = useState<CouponData | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedCoupon, setExpandedCoupon] = useState<string | null>(null);
  const [usageData, setUsageData] = useState<
    Record<string, CouponRedemptionData[]>
  >({});
  const [loadingUsage, setLoadingUsage] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formCode, setFormCode] = useState("");
  const [formPercent, setFormPercent] = useState("");
  const [formExpiresAt, setFormExpiresAt] = useState("");
  const [formMaxUsage, setFormMaxUsage] = useState("");
  const [formIsUserSpecific, setFormIsUserSpecific] = useState(false);
  const [formTargetEmail, setFormTargetEmail] = useState("");
  // Target-plan scope (empty = any plan). MONEY-NEW.
  const [formApplicablePlans, setFormApplicablePlans] = useState<string[]>([]);
  const [formApplicableBillingPeriods, setFormApplicableBillingPeriods] =
    useState<string[]>([]);
  // Edit mode: id of the coupon being edited, or null when creating.
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchCoupons = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await listCoupons();
      setCoupons(result.coupons);
      setConfigured(result.configured);
      setMode(result.mode);
    } catch (err) {
      console.error("[Coupons] load failed:", err);
      setError("Couldn't load coupons. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCoupons();
  }, [fetchCoupons]);

  // MONEY-865: coupon redemptions happen in the web app, so this admin list goes
  // stale (USAGE showed 0/1 next to a real redemption). Re-fetch when the tab
  // regains focus so USAGE reflects new redemptions without a manual refresh.
  useEffect(() => {
    const onFocus = () => fetchCoupons();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchCoupons]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setCreating(true);
      setError(null);

      if (!formCode || formCode.length < 3) {
        setError("Coupon code must be at least 3 characters");
        return;
      }

      const percent = parseFloat(formPercent);
      if (isNaN(percent) || percent <= 0 || percent > 100) {
        setError("Discount must be between 0.1% and 100%");
        return;
      }

      if (formIsUserSpecific && !formTargetEmail) {
        setError("User-specific coupons require a target email");
        return;
      }

      if (editingId) {
        // Edit: code + user-specific scope are immutable.
        await updateCoupon(editingId, {
          name: formName || null,
          discountPercent: percent,
          maxUsage: formMaxUsage ? parseInt(formMaxUsage, 10) : null,
          expiresAt: formExpiresAt || null,
          applicablePlans: formApplicablePlans,
          applicableBillingPeriods: formApplicableBillingPeriods,
        });
      } else {
        await createCoupon({
          code: formCode,
          name: formName || undefined,
          discountPercent: percent,
          maxUsage: formMaxUsage ? parseInt(formMaxUsage, 10) : undefined,
          expiresAt: formExpiresAt || undefined,
          isUserSpecific: formIsUserSpecific,
          targetUserEmail: formIsUserSpecific ? formTargetEmail : undefined,
          applicablePlans: formApplicablePlans,
          applicableBillingPeriods: formApplicableBillingPeriods,
        });
      }

      setShowCreate(false);
      resetForm();
      await fetchCoupons();
    } catch (err) {
      console.error("[Coupons] save failed:", err);
      setError("Couldn't save the coupon. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const resetForm = () => {
    setFormName("");
    setFormCode("");
    setFormPercent("");
    setFormExpiresAt("");
    setFormMaxUsage("");
    setFormIsUserSpecific(false);
    setFormTargetEmail("");
    setFormApplicablePlans([]);
    setFormApplicableBillingPeriods([]);
    setEditingId(null);
  };

  const startEdit = (c: CouponData) => {
    setError(null);
    setEditingId(c.id);
    setFormCode(c.code);
    setFormName(c.name ?? "");
    setFormPercent(String(c.discountPercent));
    setFormMaxUsage(c.maxUsage != null ? String(c.maxUsage) : "");
    // ISO -> "YYYY-MM-DDTHH:mm" for <input type="datetime-local">
    setFormExpiresAt(c.expiresAt ? c.expiresAt.slice(0, 16) : "");
    setFormIsUserSpecific(c.isUserSpecific);
    setFormTargetEmail(c.targetUserEmail ?? "");
    setFormApplicablePlans(c.applicablePlans);
    setFormApplicableBillingPeriods(c.applicableBillingPeriods);
    setShowCreate(true);
  };

  const handleToggleActive = async (couponId: string, nextActive: boolean) => {
    try {
      setBusyId(couponId);
      setError(null);
      await setCouponActive(couponId, nextActive);
      setCoupons((prev) =>
        prev.map((c) =>
          c.id === couponId ? { ...c, isActive: nextActive } : c,
        ),
      );
    } catch (err) {
      console.error("[Coupons] status update failed:", err);
      setError("Couldn't update the coupon status. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  // Confirmation is handled by the modal (setConfirmDelete); this performs the
  // delete and surfaces the action's PRECISE reason on failure (e.g. a redeemed
  // coupon can't be deleted) instead of a generic message.
  const doDelete = async (couponId: string) => {
    try {
      setBusyId(couponId);
      setError(null);
      const res = await deleteCoupon(couponId);
      if (!res.success) {
        setError(res.error ?? "Couldn't delete the coupon. Please try again.");
        setConfirmDelete(null);
        return;
      }
      setCoupons((prev) => prev.filter((c) => c.id !== couponId));
      setConfirmDelete(null);
    } catch (err) {
      console.error("[Coupons] delete failed:", err);
      setError("Couldn't delete the coupon. Please try again.");
      setConfirmDelete(null);
    } finally {
      setBusyId(null);
    }
  };

  const toggleUsage = async (couponId: string) => {
    if (expandedCoupon === couponId) {
      setExpandedCoupon(null);
      return;
    }

    setExpandedCoupon(couponId);
    if (!usageData[couponId]) {
      try {
        setLoadingUsage(couponId);
        const data = await getCouponUsage(couponId);
        setUsageData((prev) => ({ ...prev, [couponId]: data }));
      } catch {
        // Silently fail - will show empty state
      } finally {
        setLoadingUsage(null);
      }
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Coupons & Discounts</h1>
          <p className="text-muted-foreground mt-1">
            Manage discount codes for subscriptions
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Create Coupon
        </button>
      </div>

      {!loading && !configured && (
        <div className="flex items-center gap-2 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p className="text-sm">
            Dodo Payments is not configured{mode ? ` (mode: ${mode})` : ""}.
            Coupons will be saved locally but won&apos;t apply to payments until{" "}
            <code className="px-1 py-0.5 rounded bg-muted text-xs">
              DODO_PAYMENTS_API_KEY
            </code>{" "}
            is set.
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold mb-4">
            {editingId ? "Edit Coupon" : "New Coupon"}
          </h2>
          <form onSubmit={handleCreate} className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Coupon Code *
              </label>
              <input
                type="text"
                value={formCode}
                onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                placeholder="e.g. LAUNCH20"
                required
                minLength={3}
                disabled={!!editingId}
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm disabled:opacity-50"
              />
              {editingId && (
                <p className="text-xs text-muted-foreground mt-1">
                  Code can&apos;t be changed after creation.
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Name (optional)
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Launch Offer"
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">
                Discount % *
              </label>
              <input
                type="number"
                value={formPercent}
                onChange={(e) => setFormPercent(e.target.value)}
                placeholder="e.g. 20 for 20%"
                required
                min={0.1}
                max={100}
                step={0.1}
                className="w-full px-3 py-2 rounded-lg border bg-background text-sm"
              />
              {formPercent && (
                <p className="text-xs text-muted-foreground mt-1">
                  {parseFloat(formPercent)}% off
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Max Usage (leave empty for unlimited)
              </label>
              <input
                type="number"
                value={formMaxUsage}
                onChange={(e) => setFormMaxUsage(e.target.value)}
                placeholder="Unlimited"
                min={1}
                disabled={formIsUserSpecific}
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm disabled:opacity-50"
              />
              {formIsUserSpecific && (
                <p className="text-xs text-muted-foreground mt-1">
                  User-specific coupons are always one-time use
                </p>
              )}
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

            {/* Applicable-plan scope (MONEY-NEW) */}
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">
                Applies to plan(s)
              </label>
              <div className="flex gap-2">
                {(["PRO", "PREMIUM"] as const).map((plan) => {
                  const on = formApplicablePlans.includes(plan);
                  return (
                    <button
                      key={plan}
                      type="button"
                      onClick={() =>
                        setFormApplicablePlans((prev) =>
                          prev.includes(plan)
                            ? prev.filter((p) => p !== plan)
                            : [...prev, plan],
                        )
                      }
                      className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                        on
                          ? "border-primary bg-primary/10 text-primary"
                          : "hover:bg-muted"
                      }`}
                    >
                      {plan}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {formApplicablePlans.length === 0
                  ? "Valid for any plan."
                  : `Only when upgrading to ${formApplicablePlans.join(" or ")}.`}
              </p>
            </div>

            {/* Applicable billing-cycle scope (MONEY-865) */}
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">
                Applies to billing cycle(s)
              </label>
              <div className="flex gap-2">
                {(["monthly", "annual"] as const).map((period) => {
                  const on = formApplicableBillingPeriods.includes(period);
                  return (
                    <button
                      key={period}
                      type="button"
                      onClick={() =>
                        setFormApplicableBillingPeriods((prev) =>
                          prev.includes(period)
                            ? prev.filter((p) => p !== period)
                            : [...prev, period],
                        )
                      }
                      className={`px-3 py-2 rounded-lg border text-sm capitalize transition-colors ${
                        on
                          ? "border-primary bg-primary/10 text-primary"
                          : "hover:bg-muted"
                      }`}
                    >
                      {period}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {formApplicableBillingPeriods.length === 0
                  ? "Valid for both monthly & annual."
                  : `Only for ${formApplicableBillingPeriods.join(" & ")} billing.`}
              </p>
            </div>

            {/* Coupon Type Toggle */}
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-2 block">
                Coupon Type
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setFormIsUserSpecific(false);
                    setFormTargetEmail("");
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                    !formIsUserSpecific
                      ? "border-primary bg-primary/10 text-primary"
                      : "hover:bg-muted"
                  }`}
                >
                  <Users className="h-4 w-4" />
                  General
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFormIsUserSpecific(true);
                    setFormMaxUsage("");
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                    formIsUserSpecific
                      ? "border-primary bg-primary/10 text-primary"
                      : "hover:bg-muted"
                  }`}
                >
                  <User className="h-4 w-4" />
                  User-Specific
                </button>
              </div>
            </div>

            {/* Target Email (shown only for user-specific) */}
            {formIsUserSpecific && (
              <div className="sm:col-span-2">
                <label className="text-sm font-medium text-muted-foreground">
                  Target User Email *
                </label>
                <input
                  type="email"
                  value={formTargetEmail}
                  onChange={(e) => setFormTargetEmail(e.target.value)}
                  placeholder="user@example.com"
                  required
                  className="mt-1 w-full px-3 py-2 rounded-lg border bg-background text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Only this user can apply this coupon (one-time use)
                </p>
              </div>
            )}

            <div className="sm:col-span-2 flex items-end">
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editingId ? "Save changes" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    resetForm();
                  }}
                  className="px-4 py-2 rounded-lg border hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Coupons Table */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center gap-3 p-6 border-b">
          <div className="p-2 rounded-lg bg-primary/10">
            <Tag className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Coupons</h2>
            <p className="text-sm text-muted-foreground">
              {coupons.length} coupon{coupons.length !== 1 ? "s" : ""} total
              {mode ? ` · Dodo ${mode}` : ""}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : coupons.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Tag className="h-8 w-8 mx-auto mb-3 opacity-50" />
            <p>No coupons yet</p>
            <p className="text-sm mt-1">Create one to get started</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Code
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Name
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Discount
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Type
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase">
                    Usage
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
                {coupons.map((c) => (
                  <Fragment key={c.id}>
                    <tr
                      className={`border-b last:border-0 ${!c.isActive ? "opacity-50" : ""}`}
                    >
                      <td className="px-6 py-4">
                        <button
                          onClick={() => toggleUsage(c.id)}
                          className="flex items-center gap-1"
                        >
                          {expandedCoupon === c.id ? (
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                          )}
                          <code className="px-2 py-1 rounded bg-muted text-sm font-mono">
                            {c.code}
                          </code>
                        </button>
                      </td>
                      <td className="px-6 py-4 text-sm">{c.name || "-"}</td>
                      <td className="px-6 py-4 text-sm font-medium">
                        {c.discountPercent}%
                      </td>
                      <td className="px-6 py-4 text-sm">
                        {c.isUserSpecific ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 text-xs">
                            <User className="h-3 w-3" />
                            {c.targetUserEmail}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs">
                            <Users className="h-3 w-3" />
                            General
                          </span>
                        )}
                        {c.applicablePlans.length > 0 && (
                          <div className="text-xs text-muted-foreground mt-1">
                            {c.applicablePlans.join(", ")} only
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {c.currentUsage} / {c.maxUsage ?? "∞"}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {c.expiresAt
                          ? new Date(c.expiresAt).toLocaleDateString()
                          : "Never"}
                      </td>
                      <td className="px-6 py-4">
                        {(() => {
                          // MONEY-866: drive the pill from the server-computed
                          // displayStatus (shared couponDisplayStatus) — no inline
                          // re-derivation of exhausted/expired here.
                          if (c.displayStatus === "paused") {
                            return (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-xs">
                                Paused
                              </span>
                            );
                          }
                          if (
                            c.displayStatus === "exhausted" ||
                            c.displayStatus === "expired"
                          ) {
                            return (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-zinc-500/10 text-zinc-400 text-xs">
                                {c.displayStatus === "exhausted"
                                  ? "Exhausted"
                                  : "Expired"}
                              </span>
                            );
                          }
                          return (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs">
                              Active
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => startEdit(c)}
                            disabled={busyId === c.id}
                            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                            title="Edit coupon"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() =>
                              handleToggleActive(c.id, !c.isActive)
                            }
                            disabled={busyId === c.id}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-xs hover:bg-muted disabled:opacity-50 transition-colors"
                            title={
                              c.isActive ? "Suspend coupon" : "Resume coupon"
                            }
                          >
                            {busyId === c.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : c.isActive ? (
                              <>
                                <Pause className="h-3 w-3" /> Suspend
                              </>
                            ) : (
                              <>
                                <Play className="h-3 w-3" /> Resume
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(c)}
                            disabled={busyId === c.id}
                            className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
                            title="Delete coupon"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {/* Usage detail row */}
                    {expandedCoupon === c.id && (
                      <tr key={`${c.id}-usage`} className="border-b">
                        <td colSpan={8} className="px-6 py-3 bg-muted/30">
                          {loadingUsage === c.id ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Loading usage...
                            </div>
                          ) : !usageData[c.id]?.length ? (
                            <p className="text-sm text-muted-foreground">
                              No redemptions yet
                            </p>
                          ) : (
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
                                Redemption History
                              </p>
                              {usageData[c.id].map((r) => (
                                <div
                                  key={r.id}
                                  className="flex items-center gap-4 text-sm"
                                >
                                  <span className="text-muted-foreground">
                                    {new Date(r.redeemedAt).toLocaleString()}
                                  </span>
                                  <span>{r.userEmail}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete-confirmation modal — replaces the native window.confirm(). */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">
              Delete coupon{" "}
              <span className="font-mono">{confirmDelete.code}</span>?
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This permanently removes the coupon and its linked Dodo discount.
              A coupon that has already been redeemed can&apos;t be deleted —
              Suspend it instead.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                disabled={busyId === confirmDelete.id}
                className="px-4 py-2 rounded-lg border text-sm hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => doDelete(confirmDelete.id)}
                disabled={busyId === confirmDelete.id}
                className="px-4 py-2 rounded-lg bg-red-600 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busyId === confirmDelete.id ? "Deleting…" : "Delete coupon"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
