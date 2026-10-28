/**
 * Date bucketing for the side-panel chat history.
 *
 * Ported from the pre-redesign sidebar, which grouped saved chats into Today /
 * Yesterday / Last 7 Days / Last 30 Days / Older. The in-panel list that
 * replaced it rendered one flat run of rows, so finding a specific chat meant
 * reading every date stamp.
 *
 * `now` is injected throughout. A grouping function asserted against the real
 * clock is a test whose meaning changes at local midnight — the exact class of
 * flake this suite exists to avoid.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  groupChatsByDate,
  type ChatDateGroup,
} from "../../lib/chat-history/group-by-date";

/** Fixed reference: 2026-08-26, mid-afternoon LOCAL time. */
const NOW = new Date(2026, 7, 26, 15, 30, 0, 0);

/** Local-midnight-anchored offset, mirroring the implementation. */
const daysAgo = (days: number, h = 12) =>
  new Date(2026, 7, 26 - days, h, 0, 0, 0);

const entry = (id: string, lastMessageAt: Date | string | number) => ({
  id,
  lastMessageAt,
});

/**
 * Flatten to `[label, ids]` pairs for readable assertions.
 *
 * Generic rather than `ReturnType<typeof groupChatsByDate>`: that form
 * resolves the type parameter to its CONSTRAINT (`DatedChatEntry`, which has
 * no `id`), so reading `e.id` needed a cast that TypeScript then rejected as
 * non-overlapping. Threading the entry type through keeps it honest.
 */
const shape = <T extends { id: string }>(groups: ChatDateGroup<T>[]) =>
  groups.map((g) => [g.label, g.entries.map((e) => e.id)]);

describe("groupChatsByDate", () => {
  test("buckets each entry into the right group", () => {
    const groups = groupChatsByDate(
      [
        entry("a", daysAgo(0)),
        entry("b", daysAgo(1)),
        entry("c", daysAgo(3)),
        entry("d", daysAgo(20)),
        entry("e", daysAgo(400)),
      ],
      NOW
    );
    assert.deepEqual(shape(groups), [
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Last 7 Days", ["c"]],
      ["Last 30 Days", ["d"]],
      ["Older", ["e"]],
    ]);
  });

  test("drops empty groups instead of rendering bare headings", () => {
    const groups = groupChatsByDate(
      [entry("a", daysAgo(0)), entry("b", daysAgo(45))],
      NOW
    );
    assert.deepEqual(shape(groups), [
      ["Today", ["a"]],
      ["Older", ["b"]],
    ]);
  });

  test("returns [] for no entries", () => {
    assert.deepEqual(groupChatsByDate([], NOW), []);
  });

  test("preserves the caller's order within a bucket", () => {
    // Callers list newest-first; re-sorting here would override a caller that
    // deliberately ordered otherwise.
    const groups = groupChatsByDate(
      [
        entry("newer", new Date(2026, 7, 26, 14, 0)),
        entry("older", new Date(2026, 7, 26, 9, 0)),
      ],
      NOW
    );
    assert.deepEqual(shape(groups), [["Today", ["newer", "older"]]]);
  });

  test("local midnight exactly is Today, one ms before is Yesterday", () => {
    const midnight = new Date(2026, 7, 26, 0, 0, 0, 0);
    const justBefore = new Date(midnight.getTime() - 1);
    const groups = groupChatsByDate(
      [entry("mid", midnight), entry("before", justBefore)],
      NOW
    );
    assert.deepEqual(shape(groups), [
      ["Today", ["mid"]],
      ["Yesterday", ["before"]],
    ]);
  });

  test("the 7-day edge falls on the right side", () => {
    // Boundary is local midnight 7 days back: that instant is "Last 7 Days",
    // one ms earlier is "Last 30 Days".
    const edge = new Date(2026, 7, 19, 0, 0, 0, 0);
    const groups = groupChatsByDate(
      [entry("edge", edge), entry("before", new Date(edge.getTime() - 1))],
      NOW
    );
    assert.deepEqual(shape(groups), [
      ["Last 7 Days", ["edge"]],
      ["Last 30 Days", ["before"]],
    ]);
  });

  test("[regression] an unparseable date lands in Older, never Today", () => {
    // `new Date("nonsense").getTime()` is NaN and every `>=` against NaN is
    // false, so it falls through to the LAST branch. If the NaN check ever
    // moved to the front of the chain, a row whose date we failed to read
    // would silently assert it was from today.
    const groups = groupChatsByDate(
      [entry("bad", "not-a-date"), entry("good", daysAgo(0))],
      NOW
    );
    assert.deepEqual(shape(groups), [
      ["Today", ["good"]],
      ["Older", ["bad"]],
    ]);
  });

  test("accepts ISO strings and epoch millis, not just Date", () => {
    // The hook hands through whatever the server action deserialised, which
    // for a JSON round-trip is a string.
    const groups = groupChatsByDate(
      [
        entry("iso", daysAgo(0).toISOString()),
        entry("ms", daysAgo(1).getTime()),
      ],
      NOW
    );
    assert.deepEqual(shape(groups), [
      ["Today", ["iso"]],
      ["Yesterday", ["ms"]],
    ]);
  });

  test("a future timestamp reads as Today rather than vanishing", () => {
    // Clock skew between the user's machine and the server is normal; the row
    // must still render somewhere.
    const groups = groupChatsByDate(
      [entry("future", new Date(2026, 7, 27, 10, 0))],
      NOW
    );
    assert.deepEqual(shape(groups), [["Today", ["future"]]]);
  });

  test("month and year boundaries do not create phantom buckets", () => {
    // 1 Jan: "yesterday" is in the previous YEAR. Date(y, 0, 1 - 1) handles
    // the rollover, but only because the offset is applied to the day field
    // rather than by subtracting 86_400_000 from a timestamp (which breaks
    // across a DST change).
    const newYear = new Date(2027, 0, 1, 10, 0);
    const groups = groupChatsByDate(
      [
        entry("today", new Date(2027, 0, 1, 9, 0)),
        entry("yday", new Date(2026, 11, 31, 23, 0)),
      ],
      newYear
    );
    assert.deepEqual(shape(groups), [
      ["Today", ["today"]],
      ["Yesterday", ["yday"]],
    ]);
  });
});
