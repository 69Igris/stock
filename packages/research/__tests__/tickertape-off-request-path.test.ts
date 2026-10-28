/**
 * MONEY-1220 — Tickertape is off the REQUEST path too.
 *
 * The scheduled half is covered by
 * `packages/core/__tests__/market-data/tickertape-retired.test.ts`. This is the
 * other half, and it fails differently: a nightly job that 403s writes nothing
 * and nobody notices for five months, whereas a REQUEST that 403s makes a user
 * wait for a doomed HTTP round trip before the fallback they were always going
 * to get anyway.
 *
 * The two rules pinned here:
 *
 *   1. Our own `StockFinancials` is the authority, and a STALE row from it
 *      beats an external fetch. The refresher is `xbrl-projection`, a nightly
 *      job over archived filings — not something a request can trigger, so
 *      "stale" is no longer a reason to go anywhere.
 *   2. A read path never PERSISTS. `StockFinancials` has no `source` in its
 *      unique key, so a request-time write from the weakest source in
 *      FINANCIALS_AUTHORITY could occupy a period the projection then has to
 *      displace.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src", "data-sources");
const read = (f: string): string => readFileSync(join(SRC, f), "utf8");

/** Comments stripped — prose about the removal is not the removal. */
const code = (f: string): string =>
  read(f)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

describe("getOrFetchFinancials — our tables, always", () => {
  const src = code("db-store.ts");

  it("makes no Tickertape call", () => {
    // The function used to fall through to `fetchTickertapeFinancials` /
    // `fetchTickertapeQuarterlyResults` on a miss or on staleness.
    const fn = src.slice(
      src.indexOf("export async function getOrFetchFinancials"),
      src.indexOf(
        "export ",
        src.indexOf("export async function getOrFetchFinancials") + 10,
      ),
    );
    assert.doesNotMatch(fn, /fetchTickertape/);
    assert.doesNotMatch(fn, /resolveTickertapeSid/);
  });

  it("serves a STALE stored row rather than failing or emptying", () => {
    // A stale real number beats a failed fetch, and beats a silent empty by
    // more. `isStale` is still consulted — to LOG, not to branch away.
    const fn = read("db-store.ts");
    assert.match(fn, /isStale\(newest\.fetchedAt, stalenessKey\)/);
    assert.match(fn, /serving the stored copy/);
  });

  it("never writes on the read path", () => {
    const fn = src.slice(
      src.indexOf("export async function getOrFetchFinancials"),
      src.indexOf(
        "export ",
        src.indexOf("export async function getOrFetchFinancials") + 10,
      ),
    );
    for (const write of ["upsert", "createMany", "updateMany", ".create("]) {
      assert.ok(
        !fn.includes(write),
        `read path performs a ${write} — a request must not occupy a period`,
      );
    }
  });
});

describe("fetchFinancialsChain — Screener only", () => {
  const src = code("data-source-chain.ts");

  it("no longer tries Tickertape first", () => {
    // MONEY-1274 widened this from one function to the whole request path.
    // `fetchFinancialsChain` now delegates to `fetchFinancialsChainDetailed`,
    // which holds the attempt list — so slicing only the first function would
    // scan a one-line delegation and pass no matter what the delegate does.
    // Both are asserted, which is STRONGER than before: Tickertape cannot be
    // reintroduced in either half.
    const bodyOf = (name: string) => {
      const start = src.indexOf(`export async function ${name}(`);
      assert.notEqual(start, -1, `${name} not found — the chain was renamed`);
      const next = src.indexOf("\nexport ", start + 10);
      return src.slice(start, next === -1 ? undefined : next);
    };

    const plain = bodyOf("fetchFinancialsChain");
    const detailed = bodyOf("fetchFinancialsChainDetailed");

    for (const [name, fn] of [
      ["fetchFinancialsChain", plain],
      ["fetchFinancialsChainDetailed", detailed],
    ] as const) {
      assert.doesNotMatch(
        fn,
        /tickertape/i,
        `${name} must not attempt Tickertape — it 403s our egress (MONEY-1220)`,
      );
    }

    // The attempt list lives in the detailed variant; the plain one delegates.
    assert.match(detailed, /fetchScreenerFinancials/);
    assert.match(plain, /fetchFinancialsChainDetailed/);
  });

  it("keeps Screener — it is alive and already in use", () => {
    // Not a guess: `stock-document-sync` stored 49 announcements and 60+ annual
    // reports from screener.in in the week this was written, and the host
    // answers 200. It is HTML-parsed rather than an API someone can revoke.
    assert.match(src, /fetchScreenerFinancials/);
  });
});
