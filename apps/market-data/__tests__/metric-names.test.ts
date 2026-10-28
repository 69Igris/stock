/**
 * The quote counters must arrive under the names a monitor would query.
 * MONEY-1469 — and MONEY-1238 for the fourth time.
 *
 * `datadog-metrics` is initialised with `prefix: METRIC_PREFIX`, so what
 * ARRIVES is the prefix plus whatever is passed. The first cut of
 * `recordQuoteBatch` passed `"stockbook.quote.hit"` and shipped
 * `stockbook.stockbook.quote.hit` — a series that exists, carries correct
 * values, and is invisible to every dashboard and monitor written against the
 * name anyone would actually type.
 *
 * That renders as NO DATA, which is indistinguishable from a healthy idle
 * service. Nothing errors, nothing retries, nothing alerts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { METRIC_PREFIX } from "@usemoney/datadog";

import { EMITTED_QUOTE_METRICS, QUOTE_METRICS } from "../src/metrics";

test("the names PASSED are bare — the client adds the prefix", () => {
  for (const [field, name] of Object.entries(QUOTE_METRICS)) {
    assert.ok(
      !name.startsWith(METRIC_PREFIX),
      `${field} is passed as "${name}", which ships as "${METRIC_PREFIX}${name}" — double-prefixed and unqueryable`,
    );
    assert.match(
      name,
      /^quote\./,
      `${field} must live under the quote namespace`,
    );
  }
});

test("the EMITTED names are what a monitor queries", () => {
  // Stated as literals, deliberately. These are the strings that go into a
  // Datadog monitor, and deriving both sides from the same expression would let
  // the pair move together and still agree while every saved query broke.
  assert.equal(EMITTED_QUOTE_METRICS.hit, "stockbook.quote.hit");
  assert.equal(EMITTED_QUOTE_METRICS.miss, "stockbook.quote.miss");
  assert.equal(EMITTED_QUOTE_METRICS.stale, "stockbook.quote.stale");
});

test("hit and miss are BOTH present, or the ratio cannot be alerted on", () => {
  // `miss` alone is zero when the store is healthy AND zero when nothing is
  // asking — opposite states. The monitor reads the ratio, so both halves have
  // to exist; and `stale` is its own series because a weekend is legitimately
  // all-stale and must not read as a total store failure.
  assert.deepEqual(Object.keys(QUOTE_METRICS).sort(), ["hit", "miss", "stale"]);
});
