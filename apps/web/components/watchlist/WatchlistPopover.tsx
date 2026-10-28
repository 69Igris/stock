"use client";

/**
 * Shared Watchlist popover. Used on:
 *   - Screener stock cards (`+ Watchlist` / `In N` button)
 *   - Stock detail page action bar
 *   - Fund detail page action bar (kind="MF")
 *   - (any future card surface)
 *
 * Behavior:
 *   - On open: fetches current user's watchlists. The popover shows a
 *     checkbox per list reflecting whether THIS instrument
 *     (`{symbol, exchange}` for stocks, `{symbol: schemeCode, exchange: "MF"}`
 *     for funds) is currently in the list.
 *   - Toggle a row → add or remove the item server-side. We optimistically
 *     update local state so the checkbox flips immediately.
 *   - "+ New watchlist" inline row → creates a list AND adds the current
 *     instrument to it.
 *
 * No mock data - uses the real `getWatchlistsAction`,
 * `addWatchlistItemAction`, `removeWatchlistItemAction`,
 * `createWatchlistAction` server actions.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Bookmark, Check, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  getWatchlistsAction,
  addWatchlistItemAction,
  removeWatchlistItemAction,
  createWatchlistAction,
  type WatchlistData,
} from "@/lib/actions/watchlist";

export type WatchlistKind = "STOCK" | "MF";

export interface WatchlistTarget {
  /** Stock ticker, or MF scheme code. */
  symbol: string;
  /** "NSE" / "BSE" for stocks; we use "MF" for mutual funds (matches existing watchlist type filter). */
  exchange: string;
  kind: WatchlistKind;
}

interface WatchlistPopoverProps {
  /** Surface label override - caller can flag the popover as showing
   *  "ETF watchlists" even though the backend stores ETFs under
   *  WatchlistKind="STOCK". When unset we fall back to the target's kind. */
  displayKind?: "STOCK" | "MF" | "ETF";
  /** Single target - for use on individual stock/fund cards or detail pages. */
  target?: WatchlistTarget;
  /** Bulk targets - for use on the screener's bulk action toolbar. When set,
   *  takes precedence over `target` and the popover ticks lists where ALL
   *  selected items are members. Toggling adds/removes the whole batch. */
  targets?: ReadonlyArray<WatchlistTarget>;
  /** Optional override for the trigger button - defaults to the standard `+ Watchlist` / `In N` pill. */
  trigger?: React.ReactNode;
  /** Optional callback fired after every membership change so parents can re-render counts. */
  onMembershipChange?: (memberCount: number) => void;
  /** Optional callback fired when bulk add succeeds - parent can clear selection. */
  onBulkApplied?: () => void;
}

/** A list with the per-item id we'd need to call `removeWatchlistItemAction`. */
interface ListWithMembership {
  id: string;
  name: string;
  itemCount: number;
  /** Single-target mode: WatchlistItem id for THIS target if in the list. */
  membershipItemId: string | null;
  /** Bulk mode: how many of the selected targets are already in this list. */
  bulkMatchedCount: number;
  /** Bulk mode: per-target membership item IDs (for batched removal). */
  bulkItemIds: string[];
  /** Bulk mode: targets that are NOT yet in this list (for batched add). */
  bulkMissingTargets: WatchlistTarget[];
}

function matchesTarget(
  item: { symbol: string; exchange: string },
  target: WatchlistTarget
): boolean {
  return item.symbol === target.symbol && item.exchange === target.exchange;
}

function deriveLists(
  raw: WatchlistData[],
  targets: ReadonlyArray<WatchlistTarget>
): ListWithMembership[] {
  if (targets.length === 0) return [];
  const kind = targets[0]!.kind;
  // Filter to lists matching the targets' kind. Bulk mode assumes
  // homogeneous kind (all stocks or all funds) - the toolbar enforces
  // this by tabling Stocks vs Funds separately, so we don't need
  // mixed-kind support yet.
  return raw
    .filter((l) => l.type === kind)
    .map((l) => {
      const itemsBySymbol = new Map<string, string>();
      for (const it of l.items) {
        itemsBySymbol.set(`${it.symbol}|${it.exchange}`, it.id);
      }
      const bulkItemIds: string[] = [];
      const bulkMissingTargets: WatchlistTarget[] = [];
      for (const t of targets) {
        const id = itemsBySymbol.get(`${t.symbol}|${t.exchange}`);
        if (id) bulkItemIds.push(id);
        else bulkMissingTargets.push(t);
      }
      const single =
        targets.length === 1
          ? l.items.find((it) => matchesTarget(it, targets[0]!))
          : null;
      return {
        id: l.id,
        name: l.name,
        itemCount: l.itemCount,
        membershipItemId: single ? single.id : null,
        bulkMatchedCount: bulkItemIds.length,
        bulkItemIds,
        bulkMissingTargets,
      };
    });
}

export function WatchlistPopover({
  target,
  targets,
  trigger,
  onMembershipChange,
  onBulkApplied,
  displayKind,
}: WatchlistPopoverProps) {
  // Normalize: bulk mode prefers `targets`, single mode falls back to `target`.
  const effectiveTargets: WatchlistTarget[] = useMemo(() => {
    if (targets && targets.length > 0) return [...targets];
    if (target) return [target];
    return [];
  }, [target, targets]);
  const isBulk = effectiveTargets.length > 1;

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lists, setLists] = useState<ListWithMembership[]>([]);
  const [newListName, setNewListName] = useState("");
  const [creating, setCreating] = useState(false);

  const memberCount = useMemo(
    () => lists.filter((l) => l.membershipItemId != null).length,
    [lists]
  );

  // Stable cache key for the active target set - changes when the user
  // moves to a different stock/fund (single-target mode) or selects a new
  // bulk batch on the screener. Comparing identities (`effectiveTargets`)
  // would re-run the effect on every parent render because the parent
  // builds a fresh array each render.
  const targetKey = useMemo(
    () =>
      effectiveTargets
        .map((t) => `${t.kind}:${t.exchange}:${t.symbol}`)
        .sort()
        .join("|"),
    [effectiveTargets]
  );

  // Track which target set the cached `lists` corresponds to so we can
  // invalidate cleanly when the user opens the popover for a different
  // target (otherwise membership ticks reflect the prior target).
  const [cachedFor, setCachedFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (effectiveTargets.length === 0) return;
    setLoading(true);
    const res = await getWatchlistsAction();
    if (res.success && res.data) {
      setLists(deriveLists(res.data, effectiveTargets));
      setCachedFor(targetKey);
    } else if (res.error) {
      toast.error(res.error);
    }
    setLoading(false);
  }, [effectiveTargets, targetKey]);

  useEffect(() => {
    if (!open || loading) return;
    // Refetch when: nothing cached yet, OR the cached snapshot is for a
    // different target set than the one currently mounted.
    if (lists.length === 0 || cachedFor !== targetKey) {
      void refresh();
    }
  }, [open, lists.length, loading, refresh, cachedFor, targetKey]);

  // Surface the count to parent every time it changes — but ONLY once this
  // popover has actually loaded the lists it derives that count from.
  //
  // MONEY-1253 follow-up. `lists` starts `[]`, so `memberCount` is 0 on mount
  // and this effect used to publish that 0 immediately, before any fetch. The
  // screener card consumes it as
  //
  //     const memberCount = overrideCount ?? countFor(...)
  //
  // and `??` does NOT fall through on 0 — it only falls through on
  // null/undefined. So an uninitialised 0 became a permanent override: every
  // card pinned itself to "+ Watch" and never consulted `countFor` again, even
  // after the membership data arrived. The count was computed correctly the
  // whole time and thrown away one render later.
  //
  // `cachedFor` is the existing "I have fetched for this target" marker — set
  // only inside `refresh` after a successful response — so gating on it
  // reports a count only when there is a real one to report. A genuine 0 (user
  // removed the last list, or has none) still publishes, because by then a
  // fetch has happened.
  useEffect(() => {
    if (cachedFor === null) return;
    onMembershipChange?.(memberCount);
  }, [memberCount, onMembershipChange, cachedFor]);

  async function toggleMembership(list: ListWithMembership) {
    if (isBulk) {
      // Bulk mode: if any selected target is missing → add the missing
      // batch. If ALL selected are members → remove them all.
      try {
        if (list.bulkMissingTargets.length > 0) {
          // Batch add: fire each addWatchlistItem in parallel.
          const results = await Promise.all(
            list.bulkMissingTargets.map((t) =>
              addWatchlistItemAction({
                watchlistId: list.id,
                symbol: t.symbol,
                exchange: t.exchange,
              })
            )
          );
          const failed = results.filter((r) => !r.success);
          if (failed.length > 0) {
            const errMsg = failed[0]?.error ?? "Some adds failed";
            throw new Error(`${failed.length} of ${results.length}: ${errMsg}`);
          }
          toast.success(
            `Added ${list.bulkMissingTargets.length} to ${list.name}`
          );
          onBulkApplied?.();
        } else if (list.bulkItemIds.length > 0) {
          const results = await Promise.all(
            list.bulkItemIds.map((id) => removeWatchlistItemAction(id))
          );
          const failed = results.filter((r) => !r.success);
          if (failed.length > 0) {
            throw new Error(
              `${failed.length} of ${results.length}: removal failed`
            );
          }
          toast.success(`Removed from ${list.name}`);
        }
        await refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Bulk watchlist update failed"
        );
        await refresh();
      }
      return;
    }

    // Single-target path (unchanged from v3.0).
    const isMember = list.membershipItemId != null;
    setLists((prev) =>
      prev.map((l) =>
        l.id !== list.id
          ? l
          : {
              ...l,
              membershipItemId: isMember ? null : "_pending_",
              itemCount: l.itemCount + (isMember ? -1 : 1),
            }
      )
    );

    try {
      if (isMember && list.membershipItemId) {
        const res = await removeWatchlistItemAction(list.membershipItemId);
        if (!res.success) throw new Error(res.error ?? "Remove failed");
      } else {
        const t = effectiveTargets[0];
        if (!t) return;
        const res = await addWatchlistItemAction({
          watchlistId: list.id,
          symbol: t.symbol,
          exchange: t.exchange,
        });
        if (!res.success) throw new Error(res.error ?? "Add failed");
        await refresh();
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Watchlist update failed"
      );
      await refresh();
    }
  }

  async function handleCreate() {
    const name = newListName.trim();
    if (!name || effectiveTargets.length === 0) return;
    setCreating(true);
    try {
      const kind = effectiveTargets[0]!.kind;
      const res = await createWatchlistAction({ name, type: kind });
      if (!res.success || !res.data) {
        throw new Error(res.error ?? "Create failed");
      }
      // Add every target (single or bulk) to the new list in parallel.
      const adds = await Promise.all(
        effectiveTargets.map((t) =>
          addWatchlistItemAction({
            watchlistId: res.data!.id,
            symbol: t.symbol,
            exchange: t.exchange,
          })
        )
      );
      const failed = adds.filter((a) => !a.success);
      if (failed.length > 0) {
        throw new Error(failed[0]?.error ?? "Some adds failed");
      }
      setNewListName("");
      await refresh();
      toast.success(
        `Added ${effectiveTargets.length === 1 ? "" : `${effectiveTargets.length} `}to ${name}`
      );
      if (isBulk) onBulkApplied?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  const defaultTrigger = (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-[11.5px] font-medium font-mono transition-colors cursor-pointer"
      style={
        memberCount > 0
          ? {
              background: "var(--emerald-bg)",
              border: "1px solid var(--emerald)",
              color: "var(--emerald-text)",
            }
          : {
              background: "var(--paper)",
              border: "1.5px solid var(--ink)",
              color: "var(--ink-2)",
            }
      }
    >
      <Bookmark className="h-3 w-3" />
      {isBulk
        ? `+ Watchlist (${effectiveTargets.length})`
        : memberCount > 0
          ? `In ${memberCount}`
          : "+ Watchlist"}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger ?? defaultTrigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[280px] p-0 border-[1.5px] border-[var(--ink)] shadow-[4px_4px_0_var(--ink)]"
        style={{ background: "var(--paper)" }}
      >
        <div className="px-3 py-2.5 border-b border-[var(--rule-soft)] flex items-baseline gap-2">
          <span className="font-mono text-[10.5px] tracking-[1.2px] uppercase font-bold text-[var(--ink-2)]">
            {(() => {
              const k = displayKind ?? effectiveTargets[0]?.kind;
              if (k === "MF") return "Fund watchlists";
              if (k === "ETF") return "ETF watchlists";
              return "Stock watchlists";
            })()}
          </span>
          <span className="ml-auto font-mono text-[10.5px] text-[var(--ink-3)]">
            {lists.length}
          </span>
        </div>

        <div className="max-h-[260px] overflow-auto py-1">
          {loading && lists.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--ink-3)]">
              Loading…
            </div>
          ) : lists.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--ink-3)]">
              No{" "}
              {(() => {
                const k = displayKind ?? effectiveTargets[0]?.kind;
                if (k === "MF") return "fund";
                if (k === "ETF") return "ETF";
                return "stock";
              })()}{" "}
              watchlists yet. Create one below.
            </div>
          ) : (
            lists.map((l) => {
              const total = effectiveTargets.length;
              // Bulk: a list is "fully selected" iff every target is in it.
              const fullyChecked = isBulk
                ? l.bulkMatchedCount === total && total > 0
                : l.membershipItemId != null;
              const partiallyChecked =
                isBulk && l.bulkMatchedCount > 0 && l.bulkMatchedCount < total;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => toggleMembership(l)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.03] transition-colors text-left cursor-pointer"
                >
                  <span
                    className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                      fullyChecked
                        ? "bg-emerald-400/20 border-emerald-400/60"
                        : partiallyChecked
                          ? "bg-emerald-400/10 border-emerald-400/40"
                          : "border-[var(--rule-soft)]"
                    }`}
                  >
                    {fullyChecked && (
                      <Check className="h-2.5 w-2.5 text-emerald-400" />
                    )}
                    {partiallyChecked && !fullyChecked && (
                      <span
                        aria-hidden
                        className="block w-2 h-[2px] rounded-full bg-emerald-400"
                      />
                    )}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[12.5px] text-[var(--ink)]">
                    {l.name}
                  </span>
                  {isBulk ? (
                    <span className="font-mono text-[10.5px] text-[var(--ink-3)] tabular-nums">
                      {l.bulkMatchedCount}/{total}
                    </span>
                  ) : (
                    <span className="font-mono text-[10.5px] text-[var(--ink-3)] tabular-nums">
                      {l.itemCount}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="px-3 py-2.5 border-t border-[var(--rule-soft)] flex items-center gap-2">
          <input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
            }}
            placeholder="New watchlist"
            disabled={creating}
            className="flex-1 min-w-0 px-2 py-1.5 rounded-[6px] text-[12px] text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:outline-none focus:border-[var(--emerald)] transition-colors"
            style={{
              background: "var(--paper)",
              border: "1.5px solid var(--ink)",
            }}
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!newListName.trim() || creating}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-[6px] bg-emerald-400/10 border border-emerald-400/30 text-emerald-400 text-[11.5px] font-mono font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default WatchlistPopover;
