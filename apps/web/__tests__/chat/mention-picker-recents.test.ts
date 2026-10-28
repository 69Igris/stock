/**
 * StockMentionPicker - recents store + tab cycling tests.
 *
 * De-shadowed (MONEY-620). This file inlined `loadRecents`/`pushRecent` and a
 * fabricated 4-tab `cycleTab`. The helpers now live in the React-free
 * `stock-mention-logic.ts` (StockMentionPicker.tsx imports + calls them, passing
 * the real localStorage and its dynamic visible-tab list). Importing the real
 * exports surfaced two facts the shadow hid: recents accept the `"broker"`
 * mention type, and tab cycling runs over the picker's 5-tab set (incl.
 * `brokers`), not a hard-coded 4.
 *
 * Source: apps/web/components/chat/stock-mention-logic.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  loadRecents,
  pushRecent,
  cycleTab,
  RECENTS_KEY,
  RECENTS_CAP,
  type PickerTab,
} from "@/components/chat/stock-mention-logic";

// ── In-memory Storage shim (no JSDOM available) ────────────────────

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return Array.from(this.data.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

// The picker's full tab order (matches visibleTabIds when all tabs show).
const ALL_TABS: PickerTab[] = [
  "recent",
  "stocks",
  "funds",
  "brokers",
  "commands",
];

// ── Tests ──────────────────────────────────────────────────────────

describe("MentionPicker - recents store", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("returns empty array when nothing is stored", () => {
    assert.deepEqual(loadRecents(storage), []);
  });

  it("returns empty array when storage is unavailable", () => {
    assert.deepEqual(loadRecents(null), []);
  });

  it("returns empty array on corrupt JSON", () => {
    storage.setItem(RECENTS_KEY, "{not json");
    assert.deepEqual(loadRecents(storage), []);
  });

  it("filters out malformed entries", () => {
    storage.setItem(
      RECENTS_KEY,
      JSON.stringify([
        {
          symbol: "RELIANCE",
          name: "Reliance",
          exchange: "NSE",
          type: "stock",
        },
        { symbol: 42 }, // bad
        null,
        { symbol: "TCS", name: "TCS", exchange: "NSE", type: "invalid" }, // bad type
      ])
    );
    const out = loadRecents(storage);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.symbol, "RELIANCE");
  });

  it("accepts the broker mention type (the shadow rejected it)", () => {
    storage.setItem(
      RECENTS_KEY,
      JSON.stringify([
        {
          symbol: "ZERODHA",
          name: "Zerodha",
          exchange: "BROKER",
          type: "broker",
          brokerConnectionId: "conn-1",
        },
      ])
    );
    const out = loadRecents(storage);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, "broker");
  });

  it("pushRecent prepends + dedupes by symbol", () => {
    pushRecent(
      { symbol: "TCS", name: "TCS", exchange: "NSE", type: "stock" },
      storage
    );
    pushRecent(
      { symbol: "RELIANCE", name: "Reliance", exchange: "NSE", type: "stock" },
      storage
    );
    pushRecent(
      { symbol: "TCS", name: "TCS", exchange: "NSE", type: "stock" },
      storage
    );

    const out = loadRecents(storage);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.symbol, "TCS"); // newest first
    assert.equal(out[1]!.symbol, "RELIANCE");
  });

  it("caps at RECENTS_CAP entries", () => {
    for (let i = 0; i < RECENTS_CAP + 5; i++) {
      pushRecent(
        {
          symbol: `SYM${i}`,
          name: `Stock ${i}`,
          exchange: "NSE",
          type: "stock",
        },
        storage
      );
    }
    const out = loadRecents(storage);
    assert.equal(out.length, RECENTS_CAP);
    assert.equal(out[0]!.symbol, `SYM${RECENTS_CAP + 4}`); // newest is the last pushed
  });

  it("preserves type field across roundtrip", () => {
    pushRecent(
      {
        symbol: "PARAG",
        name: "Parag Parikh Flexi",
        exchange: "MF",
        type: "mf",
      },
      storage
    );
    pushRecent(
      { symbol: "NIFTYBEES", name: "Nifty BeES", exchange: "NSE", type: "etf" },
      storage
    );
    const types = loadRecents(storage)
      .map((r) => r.type)
      .sort();
    assert.deepEqual(types, ["etf", "mf"]);
  });

  it("does nothing when storage is unavailable", () => {
    // Should not throw.
    pushRecent(
      { symbol: "X", name: "X", exchange: "NSE", type: "stock" },
      null
    );
  });
});

describe("MentionPicker - tab cycling", () => {
  it("Tab cycles forward through the full visible tab set (wraps)", () => {
    assert.equal(cycleTab("recent", "next", ALL_TABS), "stocks");
    assert.equal(cycleTab("stocks", "next", ALL_TABS), "funds");
    assert.equal(cycleTab("funds", "next", ALL_TABS), "brokers");
    assert.equal(cycleTab("brokers", "next", ALL_TABS), "commands");
    assert.equal(cycleTab("commands", "next", ALL_TABS), "recent"); // wraps
  });

  it("Shift+Tab cycles backward (wraps)", () => {
    assert.equal(cycleTab("recent", "prev", ALL_TABS), "commands"); // wraps
    assert.equal(cycleTab("commands", "prev", ALL_TABS), "brokers");
    assert.equal(cycleTab("brokers", "prev", ALL_TABS), "funds");
    assert.equal(cycleTab("funds", "prev", ALL_TABS), "stocks");
    assert.equal(cycleTab("stocks", "prev", ALL_TABS), "recent");
  });

  it("cycles only within the visible (non-empty) subset of tabs", () => {
    // The picker hides empty tabs; cycling must wrap within whatever shows.
    const visible: PickerTab[] = ["recent", "commands"];
    assert.equal(cycleTab("recent", "next", visible), "commands");
    assert.equal(cycleTab("commands", "next", visible), "recent");
  });

  it("falls back to the first tab on an unknown current value", () => {
    assert.equal(cycleTab("garbage" as PickerTab, "next", ALL_TABS), "recent");
  });

  it("returns the current tab when the visible list is empty", () => {
    assert.equal(cycleTab("recent", "next", []), "recent");
  });
});
