/**
 * Broker Adapter Factory Tests
 *
 * Exercises the REAL broker factory exported from
 * packages/core/src/brokers/factory.ts (via `@usemoney/core/brokers`):
 * `getBrokerAdapter`, `getAllBrokerAdapters`, `clearAdapterCache`. These return
 * real adapter CLASS instances (constructed purely — no network at
 * construction). No inline reimplementation.
 *
 * Divergences the old shadow hid (it built a `{ broker, name }` mock):
 *   - The real factory supports 9 brokers (it also wires INTERACTIVE_BROKERS);
 *     the shadow had 8 and asserted `size === 8`. Corrected to 9 below.
 *   - Real adapters expose `.broker` but NOT a top-level `.name` (the display
 *     name lives on `.brokerInfo.name`). The shadow asserted `adapter.name`
 *     against its mock; here we assert the real `adapter.brokerInfo.name`.
 *   - The module-level cache is private, so cache-size assertions are reframed
 *     as observable behaviour: instance identity (same broker → same instance),
 *     fresh instance after clearAdapterCache(), and getAllBrokerAdapters().size.
 *
 * Source: packages/core/src/brokers/factory.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getBrokerAdapter,
  getAllBrokerAdapters,
  clearAdapterCache,
} from "@usemoney/core/brokers";
import type { BrokerType } from "@usemoney/types";

const VALID_BROKERS: BrokerType[] = [
  "ZERODHA",
  "UPSTOX",
  "DHAN",
  "FYERS",
  "ANGEL_ONE",
  "GROWW",
  "ICICI",
  "HDFC",
  "INTERACTIVE_BROKERS",
];

const BROKER_NAMES: Record<string, string> = {
  ZERODHA: "Zerodha",
  UPSTOX: "Upstox",
  DHAN: "Dhan",
  FYERS: "Fyers",
  ANGEL_ONE: "Angel One",
  GROWW: "Groww",
  ICICI: "ICICI Direct",
  HDFC: "HDFC Securities",
  INTERACTIVE_BROKERS: "Interactive Brokers",
};

/** Read the display name off the real adapter's brokerInfo. */
function nameOf(adapter: unknown): string | undefined {
  return (adapter as { brokerInfo?: { name?: string } }).brokerInfo?.name;
}
function brokerOf(adapter: unknown): string {
  return (adapter as { broker: string }).broker;
}

describe("Broker Adapter Factory (real @usemoney/core exports)", () => {
  beforeEach(() => {
    clearAdapterCache();
  });

  afterEach(() => {
    clearAdapterCache();
  });

  // --------------------------------------------------------------------------
  // getBrokerAdapter - valid brokers
  // --------------------------------------------------------------------------
  describe("getBrokerAdapter - valid brokers", () => {
    for (const broker of VALID_BROKERS) {
      it(`should return an adapter for ${broker} with the right broker + name`, () => {
        const adapter = getBrokerAdapter(broker);
        assert.strictEqual(brokerOf(adapter), broker);
        assert.strictEqual(nameOf(adapter), BROKER_NAMES[broker]);
      });
    }

    it("should set the correct broker type on every valid broker", () => {
      for (const broker of VALID_BROKERS) {
        assert.strictEqual(brokerOf(getBrokerAdapter(broker)), broker);
      }
    });

    it("should return a non-null adapter for every valid broker", () => {
      for (const broker of VALID_BROKERS) {
        const adapter = getBrokerAdapter(broker);
        assert.ok(adapter !== null && adapter !== undefined);
      }
    });
  });

  // --------------------------------------------------------------------------
  // getBrokerAdapter - caching (observable via instance identity)
  // --------------------------------------------------------------------------
  describe("getBrokerAdapter - caching", () => {
    it("should return the same instance on a second call for ZERODHA", () => {
      assert.strictEqual(
        getBrokerAdapter("ZERODHA"),
        getBrokerAdapter("ZERODHA")
      );
    });

    it("should return the same instance for every valid broker", () => {
      for (const broker of VALID_BROKERS) {
        assert.strictEqual(
          getBrokerAdapter(broker),
          getBrokerAdapter(broker),
          `Cache miss for ${broker}`
        );
      }
    });

    it("should cache adapters independently per broker", () => {
      const zerodha = getBrokerAdapter("ZERODHA");
      const upstox = getBrokerAdapter("UPSTOX");
      assert.notStrictEqual(zerodha, upstox);
      assert.strictEqual(brokerOf(zerodha), "ZERODHA");
      assert.strictEqual(brokerOf(upstox), "UPSTOX");
    });

    it("should return distinct instances for all unique brokers", () => {
      const adapters = VALID_BROKERS.map((b) => getBrokerAdapter(b));
      assert.strictEqual(new Set(adapters).size, VALID_BROKERS.length);
    });
  });

  // --------------------------------------------------------------------------
  // getBrokerAdapter - unknown broker type
  // --------------------------------------------------------------------------
  describe("getBrokerAdapter - unknown broker type", () => {
    it("should throw for unknown broker type UNKNOWN", () => {
      assert.throws(() => getBrokerAdapter("UNKNOWN" as BrokerType), {
        message: "Unknown broker type: UNKNOWN",
      });
    });

    it("should throw for empty string", () => {
      assert.throws(() => getBrokerAdapter("" as BrokerType), {
        message: "Unknown broker type: ",
      });
    });

    it("should throw for a lowercase valid broker name", () => {
      assert.throws(() => getBrokerAdapter("zerodha" as BrokerType), {
        message: "Unknown broker type: zerodha",
      });
    });

    it("should throw for a mixed-case broker name", () => {
      assert.throws(() => getBrokerAdapter("Zerodha" as BrokerType), {
        message: "Unknown broker type: Zerodha",
      });
    });

    it("should throw for a typo in the broker name", () => {
      assert.throws(() => getBrokerAdapter("ZERODA" as BrokerType), {
        message: "Unknown broker type: ZERODA",
      });
    });

    it("should throw for special characters", () => {
      assert.throws(() => getBrokerAdapter("ANGEL-ONE" as BrokerType), {
        message: "Unknown broker type: ANGEL-ONE",
      });
    });

    it("should throw an Error instance", () => {
      assert.throws(
        () => getBrokerAdapter("NONEXISTENT" as BrokerType),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        }
      );
    });

    it("should include the broker type in the error message", () => {
      assert.throws(() => getBrokerAdapter("MY_CUSTOM_BROKER" as BrokerType), {
        message: "Unknown broker type: MY_CUSTOM_BROKER",
      });
    });
  });

  // --------------------------------------------------------------------------
  // getAllBrokerAdapters
  // --------------------------------------------------------------------------
  describe("getAllBrokerAdapters", () => {
    it("should return a Map", () => {
      assert.ok(getAllBrokerAdapters() instanceof Map);
    });

    it("should return 9 adapters (real factory — shadow had 8)", () => {
      assert.strictEqual(getAllBrokerAdapters().size, 9);
    });

    for (const broker of VALID_BROKERS) {
      it(`should contain the ${broker} adapter`, () => {
        const map = getAllBrokerAdapters();
        assert.ok(map.has(broker));
        assert.strictEqual(brokerOf(map.get(broker)!), broker);
      });
    }

    it("should return the same cache reference as getBrokerAdapter populates", () => {
      const zerodha = getBrokerAdapter("ZERODHA");
      const all = getAllBrokerAdapters();
      assert.strictEqual(all.get("ZERODHA"), zerodha);
    });

    it("each adapter in the map should report its correct broker type", () => {
      for (const [broker, adapter] of Array.from(getAllBrokerAdapters())) {
        assert.strictEqual(brokerOf(adapter), broker);
      }
    });
  });

  // --------------------------------------------------------------------------
  // clearAdapterCache
  // --------------------------------------------------------------------------
  describe("clearAdapterCache", () => {
    it("should result in a fresh instance after clearing", () => {
      const first = getBrokerAdapter("ZERODHA");
      clearAdapterCache();
      const second = getBrokerAdapter("ZERODHA");
      assert.notStrictEqual(first, second);
    });

    it("should be safe to call on an empty cache", () => {
      clearAdapterCache();
      // A subsequent call still works.
      assert.strictEqual(brokerOf(getBrokerAdapter("ZERODHA")), "ZERODHA");
    });

    it("should allow the full set to be repopulated after clearing", () => {
      getAllBrokerAdapters();
      clearAdapterCache();
      assert.strictEqual(getAllBrokerAdapters().size, 9);
    });

    it("a fresh instance after clear should still have the correct broker + name", () => {
      getBrokerAdapter("ANGEL_ONE");
      clearAdapterCache();
      const adapter = getBrokerAdapter("ANGEL_ONE");
      assert.strictEqual(brokerOf(adapter), "ANGEL_ONE");
      assert.strictEqual(nameOf(adapter), "Angel One");
    });
  });
});
