/**
 * Pure relative-time formatter, extracted from the "use client" StockNewsTab so
 * it's unit-testable. The component calls `relativeTime(iso)` (uses Date.now);
 * tests pass an explicit `now` for determinism.
 *
 * "<1h" → "Nm ago" (1m floor), "<24h" → "Nh ago", "<30d" → "Nd ago",
 * otherwise an absolute dd Mon yyyy date. Empty string for null / invalid input.
 */
export function relativeTime(
  iso: string | null,
  now: number = Date.now()
): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const dMs = now - t;
  const minutes = Math.round(dMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(dMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(dMs / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
