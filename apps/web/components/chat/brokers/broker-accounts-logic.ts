/**
 * BrokerAccountsList - pure logic (React-free)
 *
 * The status/nickname derivation + filter + platform grouping live here, split
 * out of the `"use client"` `BrokerAccountsList.tsx` (which imports Clerk hooks
 * and server actions → `react.cache`), so they can be unit-tested under
 * `node:test`. The component imports and calls these, so production and the
 * tests run the SAME logic (no shadow).
 */

export type BrokerAccountStatus = "active" | "expired" | "never";

/**
 * Derive a connection's display status:
 *   - reauth-needed OR expired token → "expired"
 *   - never synced (no lastSync)      → "never"
 *   - otherwise                       → "active"
 * "expired" wins over "never".
 */
export function deriveBrokerStatus(b: {
  needsReauth: boolean;
  isExpired: boolean;
  lastSync?: string | Date | null;
}): BrokerAccountStatus {
  if (b.needsReauth || b.isExpired) return "expired";
  if (!b.lastSync) return "never";
  return "active";
}

/** Pick the row nickname: trimmed accountName, else trimmed brokerUserId, else "Account". */
export function deriveBrokerNickname(b: {
  accountName?: string | null;
  brokerUserId?: string | null;
}): string {
  return b.accountName?.trim() || b.brokerUserId?.trim() || "Account";
}

/**
 * Case-insensitive filter over a row's platform label OR nickname. An empty /
 * whitespace query returns the rows unchanged.
 */
export function filterBrokerRows<
  T extends { platformLabel: string; nickname: string },
>(rows: T[], query: string | undefined): T[] {
  const q = query?.trim().toLowerCase() ?? "";
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.platformLabel.toLowerCase().includes(q) ||
      r.nickname.toLowerCase().includes(q)
  );
}

/** Group rows by their `platform` key, preserving insertion order. */
export function groupByPlatform<T extends { platform: string }>(
  rows: T[]
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.platform);
    if (list) list.push(r);
    else m.set(r.platform, [r]);
  }
  return m;
}
