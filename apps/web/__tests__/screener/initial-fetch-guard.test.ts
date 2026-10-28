/**
 * MONEY-1131 — the screener client must not re-run, on mount, the screen the
 * server just resolved into its props.
 *
 * Drives the REAL guard that `app/discover/screener/client.tsx` uses
 * (`./lib/initial-fetch-guard`) — the component itself is not mountable under
 * this repo's node:test setup, so the decision lives in a pure module the
 * component imports rather than inline in the effect.
 *
 * The defect: the stocks effect fired `screenStocksAction` on mount with the
 * SAME filters / query / page / sort the server had already resolved, so every
 * screener load paid for its screen twice.
 *
 * The two ways a naive guard breaks — and why each case below exists:
 *   - arming every mode ⇒ the first visit to a tab the server did NOT screen
 *     (since MONEY-1131 that is two of the three) skips its only fetch and
 *     renders an empty table;
 *   - arming on a FAILED server screen ⇒ a transient SSR timeout becomes a
 *     permanently empty table with nothing in flight.
 *
 * Source: apps/web/app/discover/screener/lib/initial-fetch-guard.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildInitialFetchGuard,
  consumeInitialFetchSkip,
} from "../../app/discover/screener/lib/initial-fetch-guard";

const MODES = ["stocks", "mf", "etf"] as const;

describe("screener initial-fetch guard (MONEY-1131)", () => {
  it("skips exactly one fetch, for the mode the server seeded", () => {
    const guard = buildInitialFetchGuard("stocks", true);

    assert.equal(
      consumeInitialFetchSkip(guard, "stocks"),
      true,
      "the mount-time run duplicates SSR and must be skipped"
    );
    assert.equal(
      consumeInitialFetchSkip(guard, "stocks"),
      false,
      "every subsequent run is a real filter/page/sort change"
    );
  });

  it("never skips a mode the server did not screen", () => {
    for (const seeded of MODES) {
      const guard = buildInitialFetchGuard(seeded, true);
      for (const other of MODES.filter((m) => m !== seeded)) {
        assert.equal(
          consumeInitialFetchSkip(guard, other),
          false,
          `${other} was never seeded when the server rendered ${seeded} — ` +
            "skipping would leave an empty table behind the tab switch"
        );
      }
    }
  });

  it("never skips when the server-side screen FAILED", () => {
    for (const mode of MODES) {
      const guard = buildInitialFetchGuard(mode, false);
      assert.equal(
        consumeInitialFetchSkip(guard, mode),
        false,
        "a timed-out / errored SSR screen must be retried client-side"
      );
    }
  });

  it("switching away and back always refetches", () => {
    const guard = buildInitialFetchGuard("mf", true);

    assert.equal(consumeInitialFetchSkip(guard, "mf"), true); // mount
    assert.equal(consumeInitialFetchSkip(guard, "stocks"), false); // → stocks
    assert.equal(
      consumeInitialFetchSkip(guard, "mf"),
      false,
      "coming back to MF must re-screen — the query may have changed"
    );
  });

  it("consuming one mode's flag does not disarm another", () => {
    // Only ever one mode is armed today, but the guard must not become a
    // single shared boolean by accident.
    const guard = { stocks: true, mf: true, etf: true };
    assert.equal(consumeInitialFetchSkip(guard, "stocks"), true);
    assert.deepEqual(guard, { stocks: false, mf: true, etf: true });
  });

  it("a double-invoked effect (React StrictMode) still fetches on its second pass", () => {
    const guard = buildInitialFetchGuard("etf", true);
    const skipped = [
      consumeInitialFetchSkip(guard, "etf"),
      consumeInitialFetchSkip(guard, "etf"),
    ];
    assert.deepEqual(
      skipped,
      [true, false],
      "the guard must degrade to a harmless extra fetch, never to none"
    );
  });
});
