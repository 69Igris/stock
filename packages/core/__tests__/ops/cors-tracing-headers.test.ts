/**
 * Datadog RUM's tracing headers must be on market-data's CORS allow list.
 * MONEY-1483.
 *
 * ## THE OUTAGE
 *
 * `CORS_ALLOW_HEADERS` was `["Authorization", "Content-Type"]`, and that made
 * the ENTIRE market-data service unreachable from any browser — every route,
 * both environments, for days.
 *
 * `apps/web` initialises RUM with
 * `allowedTracingUrls: match: /https:\/\/.*\.usemoney\.ai/` (excluding only
 * `clerk.usemoney.ai`) and `propagatorTypes: ["datadog"]`. That matches
 * `market-data{,-qa}.usemoney.ai`, so RUM injects four `x-datadog-*` headers
 * into every fetch the page makes there. They are not CORS-safelisted, so the
 * browser preflights — and the preflight came back with a list that omits them:
 *
 *     blocked by CORS policy: Request header field x-datadog-origin is not
 *     allowed by Access-Control-Allow-Headers in preflight response
 *
 * The browser surfaces that as `TypeError: Failed to fetch`. TradingView's
 * datafeed maps ANY `/config` failure to null and adopts a hardcoded default
 * demanding `/udf/symbol_info?group=NYSE|FOREX|AMEX`, so the chart died with
 * "This symbol doesn't exist" — a symbol message for a CORS fault.
 *
 * ## WHY IT SURVIVED EVERY CHECK, INCLUDING THREE WRITTEN TO CATCH IT
 *
 * The request NEVER REACHED THE ORIGIN, so no server-side instrument could see
 * it: `market-data-smoke.sh` passed 30/30 throughout. And three manual probes
 * were all false negatives:
 *
 *   - `curl` is not a browser. It neither enforces CORS nor sends RUM's headers.
 *   - An OPTIONS probe asking for `authorization` passes — that is the one
 *     header already allowed. This endpoint answers 204 with the SAME static
 *     list whatever is requested, so a 204 proves nothing; only membership does.
 *   - A Playwright page created with `page.route` has CORS enforcement DISABLED
 *     for the whole context, so no harness built that way can observe this.
 *
 * Hence a SOURCE AGREEMENT test: the two files are one rule written twice, and
 * this is the only instrument that can see them disagree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CORS_ALLOW_HEADERS } from "../../../../apps/market-data/src/app-logic";

const ROOT = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
  "..",
);
const RUM = readFileSync(
  join(ROOT, "apps/web/lib/datadog/rum-init.ts"),
  "utf8",
);

/** The headers each propagator puts on the wire. */
const PROPAGATOR_HEADERS: Record<string, string[]> = {
  datadog: [
    "x-datadog-origin",
    "x-datadog-trace-id",
    "x-datadog-parent-id",
    "x-datadog-sampling-priority",
  ],
  tracecontext: ["traceparent", "tracestate"],
  b3: ["b3"],
  b3multi: ["x-b3-traceid", "x-b3-spanid", "x-b3-sampled"],
};

function declaredPropagators(): string[] {
  return [...RUM.matchAll(/propagatorTypes:\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!),
  );
}

describe("RUM's tracing headers are accepted by the service it traces", () => {
  it("every propagator's headers are on the allow list", () => {
    const props = declaredPropagators();
    assert.ok(
      props.length > 0,
      "no propagatorTypes found in rum-init.ts — did the config move? " +
        "This test cannot protect what it cannot find.",
    );
    const allowed = new Set(CORS_ALLOW_HEADERS.map((h) => h.toLowerCase()));
    const missing: string[] = [];
    for (const p of props) {
      const needed = PROPAGATOR_HEADERS[p];
      assert.ok(
        needed,
        `unknown propagator "${p}" — add its headers to PROPAGATOR_HEADERS ` +
          `here, in the same change that enables it`,
      );
      for (const h of needed) if (!allowed.has(h)) missing.push(h);
    }
    assert.deepEqual(
      missing,
      [],
      "RUM sends these to market-data and the service refuses them at the " +
        "preflight, which makes the WHOLE service unreachable from a browser",
    );
  });

  it("RUM really does target the market-data origins", () => {
    // ANTI-VACUITY. If the match regex ever stopped covering market-data, the
    // case above would pass while protecting nothing — so the premise is
    // asserted, and asserted by EXECUTING the regex rather than eyeballing it.
    const m =
      /match:\s*\(url: string\) =>\s*([\s\S]*?),\s*\n\s*propagatorTypes/.exec(
        RUM,
      );
    assert.ok(
      m,
      "the allowedTracingUrls match arm was not found — did it move?",
    );
    const src = m[1]!;
    const re = /\/((?:[^/\\]|\\.)+)\/\.test\(url\)/.exec(src);
    assert.ok(re, `no regex literal in the match arm: ${src}`);
    const pattern = new RegExp(re[1]!);
    for (const host of [
      "https://market-data.usemoney.ai/udf/config",
      "https://market-data-qa.usemoney.ai/udf/config",
    ]) {
      assert.ok(
        pattern.test(host),
        `${host} is not matched by RUM — if that is deliberate, this whole ` +
          `agreement is moot and both files should say so`,
      );
    }
  });

  it("clerk stays excluded — the one host RUM must not trace", () => {
    assert.match(RUM, /clerk\.usemoney\.ai/);
  });
});
