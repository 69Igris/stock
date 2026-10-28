/**
 * Bucket saved chats into Today / Yesterday / Last 7 Days / Last 30 Days /
 * Older, the way the pre-redesign chat sidebar did.
 *
 * The in-panel history that replaced that sidebar rendered one flat list with a
 * date stamp per row, which is legible at five chats and useless at fifty —
 * scanning for "the one from this morning" means reading every stamp. The
 * grouping is the part of the old sidebar that actually did the finding.
 *
 * Pure and React-free so it can be unit-tested under node:test, with `now`
 * injected rather than read from the clock — a grouping function tested
 * against the real clock is a test that changes meaning at midnight.
 *
 * Boundaries are LOCAL midnight, matching the old sidebar. That is deliberate
 * and not an oversight about the app's IST-anchored server windows: those
 * exist so a QUERY means the same thing on a UTC server and an IST laptop,
 * whereas this is a reader looking at their own screen, for whom "Today" means
 * their own day.
 */

/** Anything carrying a last-activity timestamp; the entry type is preserved. */
export interface DatedChatEntry {
  lastMessageAt: Date | string | number;
}

export type ChatDateGroupLabel =
  | "Today"
  | "Yesterday"
  | "Last 7 Days"
  | "Last 30 Days"
  | "Older";

export interface ChatDateGroup<T> {
  label: ChatDateGroupLabel;
  entries: T[];
}

/** Local midnight `days` before the local midnight of `now`. */
function localMidnightOffset(now: Date, days: number): number {
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
    0,
    0,
    0,
    0
  );
  return d.getTime();
}

/**
 * Group newest-first entries into ordered, NON-EMPTY buckets.
 *
 * Empty buckets are dropped rather than returned: the caller renders a heading
 * per group, and a heading with nothing under it is worse than no heading.
 *
 * Order within a bucket is the order given — callers already sort by
 * `lastMessageAt` desc, and re-sorting here would quietly override a caller
 * that meant something else.
 *
 * An unparseable or missing timestamp yields `NaN`, and every `>=` against NaN
 * is false, so such an entry falls through to "Older". That is the honest
 * bucket for "we do not know when this was" — and it is load-bearing that it
 * is the LAST branch rather than the first: a NaN landing in "Today" would
 * quietly assert recency about a row whose date we failed to read.
 */
export function groupChatsByDate<T extends DatedChatEntry>(
  entries: readonly T[],
  now: Date = new Date()
): ChatDateGroup<T>[] {
  const todayStart = localMidnightOffset(now, 0);
  const yesterdayStart = localMidnightOffset(now, 1);
  const last7Start = localMidnightOffset(now, 7);
  const last30Start = localMidnightOffset(now, 30);

  const today: T[] = [];
  const yesterday: T[] = [];
  const last7Days: T[] = [];
  const last30Days: T[] = [];
  const older: T[] = [];

  for (const entry of entries) {
    const t = new Date(entry.lastMessageAt).getTime();
    if (t >= todayStart) today.push(entry);
    else if (t >= yesterdayStart) yesterday.push(entry);
    else if (t >= last7Start) last7Days.push(entry);
    else if (t >= last30Start) last30Days.push(entry);
    else older.push(entry);
  }

  return (
    [
      { label: "Today" as const, entries: today },
      { label: "Yesterday" as const, entries: yesterday },
      { label: "Last 7 Days" as const, entries: last7Days },
      { label: "Last 30 Days" as const, entries: last30Days },
      { label: "Older" as const, entries: older },
    ] satisfies ChatDateGroup<T>[]
  ).filter((g) => g.entries.length > 0);
}
