import type { AssetClass } from "./types";

/**
 * Enforce the 100%-allocation invariant, preserving the assets the caller set
 * explicitly (their names in `preserveNames`) and redistributing the remainder
 * across the rest — largest-remainder rounding keeps the total exactly 100.
 *
 * Shared by BOTH FIRE chat surfaces (MONEY-1079): the client bridge (on-page
 * sliders) and the server turn engine (off-page main-chat + apps/api) call this
 * one function, so on-page and off-page edits can never drift. Previously lived
 * in bridge.ts (the React file); moved here so the framework-free engine can use
 * it without reaching into web.
 *
 * Assumes integer allocations (sliders + the executor's clamped tool inputs both
 * yield integers). MONEY-1049: "make my plan more conservative" used to leave the
 * mix at 95% because a weak model changed some assets without rebalancing.
 */
export function rebalanceAssetAllocations(
  assets: AssetClass[],
  preserveNames: string[],
): AssetClass[] {
  if (assets.length === 0) return assets;
  const total = assets.reduce((s, a) => s + a.allocation, 0);
  if (Math.abs(total - 100) < 0.5) return assets; // already balanced

  const preserve = new Set(preserveNames.map((n) => n.toLowerCase()));
  const preservedSum = assets
    .filter((a) => preserve.has(a.name.toLowerCase()))
    .reduce((s, a) => s + a.allocation, 0);

  // Indices we're allowed to move.
  let idxs = assets
    .map((a, i) => (preserve.has(a.name.toLowerCase()) ? -1 : i))
    .filter((i) => i >= 0);
  let target = 100 - preservedSum;

  // Can't preserve (nothing free, or preserved already ≥ 100) → scale all.
  if (idxs.length === 0 || target < 0) {
    idxs = assets.map((_, i) => i);
    target = 100;
  }

  const curSum = idxs.reduce((s, i) => s + assets[i]!.allocation, 0);
  const ideal = idxs.map((i) =>
    curSum > 0
      ? (assets[i]!.allocation * target) / curSum
      : target / idxs.length,
  );

  // Floor everyone, then hand the remaining units to the largest remainders.
  const alloc = ideal.map((v) => Math.floor(v));
  let remaining = target - alloc.reduce((s, v) => s + v, 0);
  const order = ideal
    .map((v, k) => ({ k, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let n = 0; n < order.length && remaining > 0; n++) {
    alloc[order[n]!.k]! += 1;
    remaining -= 1;
  }

  const byIdx = new Map<number, number>();
  idxs.forEach((i, k) => byIdx.set(i, alloc[k]!));

  return assets.map((a, i) =>
    byIdx.has(i) ? { ...a, allocation: byIdx.get(i)! } : a,
  );
}
