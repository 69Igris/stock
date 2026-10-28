/**
 * MONEY-1220 — Tickertape is gone from every SCHEDULED path.
 *
 * It is not down. `api.tickertape.in` answers 200 from a laptop and 403 from
 * Cloud Run: it has blocked our production egress, which is worse than an
 * outage because it is silent and permanent. `financial-data-sync` kept running
 * on time, kept reporting success, and wrote zero rows — for five months.
 *
 * These tests pin the removal, and one thing about the removal that is easy to
 * get wrong in a way that costs a weekly dead-letter alert forever.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bashArrayBody } from "./_bash-array";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const SCHED = read("scripts/ops/setup-scheduler.sh");
const PUBSUB = read("workers/scripts/setup-pubsub.sh");
const ROUTE = read("workers/src/routes/financial-data-sync.ts");
const DB_STORE = read("packages/research/src/data-sources/db-store.ts");

/**
 * Strip comments before asserting on code — MONEY-1143, and this file earned it
 * the hard way. The first version of the read-path assertions below matched
 * `fetchTickertape` inside the very comment explaining why the fetch was
 * removed, so the test failed on a correct file. LINE comments first, then
 * BLOCK: doing it the other way round leaves a commented-out block delimiter
 * behind and the second pass eats real code.
 */
function stripComments(src: string): string {
  return src
    .replace(/^[^\S\r\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const DB_STORE_CODE = stripComments(DB_STORE);
const FIN_TOOL = stripComments(
  read("packages/research/src/tools/fetch-tickertape-financials.ts"),
);
const CHAIN = stripComments(
  read("packages/research/src/data-sources/data-source-chain.ts"),
);

/** Every .ts under workers/src, so a new importer cannot slip in. */
function workerSources(dir = join(ROOT, "workers", "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...workerSources(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("Tickertape is out of the scheduled path", () => {
  it("no worker source imports a Tickertape fetcher", () => {
    // The whole point. `workers/src` is what runs on a schedule; a single
    // surviving import puts a 403 back into a nightly job.
    const offenders = workerSources()
      .filter((f) => {
        // Comments stripped: what matters is whether CODE reaches Tickertape.
        // Several modules legitimately explain in prose that they used to, and
        // that history is worth keeping — MONEY-1205's shadow-test lesson lives
        // in one of them. LINE before BLOCK (MONEY-1143): a `//` containing
        // `/*` otherwise opens a phantom block and eats the rest of the file.
        const src = readFileSync(f, "utf8")
          .replace(/\/\/[^\n]*/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        return (
          /from ["'][^"']*tickertape-client["']/.test(src) ||
          /\bfetchTickertape\w+/.test(src) ||
          /\bresolveTickertapeSid\b/.test(src)
        );
      })
      .map((f) => f.slice(ROOT.length + 1));
    assert.deepEqual(offenders, [], "a worker still calls Tickertape");
  });

  it("the retired processor file is gone", () => {
    assert.ok(
      !existsSync(join(ROOT, "workers/src/processors/financial-data-sync.ts")),
      "the Tickertape processor is still present",
    );
  });

  it("both schedulers are removed AND listed for deletion", () => {
    // Two separate facts, and only the second one touches production.
    //
    // Deleting a definition stops this script CREATING the job. It does nothing
    // at all to the job already live in Cloud Scheduler, which would keep firing
    // weekly forever. `OLD_SCHEDULER_PREFIXES` is what takes it down.
    const defs = SCHED.split("\n").filter((l) =>
      /^\s*"(financial-data-sync-weekly|ratios-sync-daily)\|/.test(l),
    );
    assert.deepEqual(defs, [], "a retired scheduler is still defined");

    const stale = bashArrayBody(SCHED, "OLD_SCHEDULER_PREFIXES");
    for (const name of ["financial-data-sync-weekly", "ratios-sync-daily"]) {
      assert.match(
        stale,
        new RegExp(`"${name}"`),
        `${name} would keep firing — it is not in OLD_SCHEDULER_PREFIXES`,
      );
    }
  });

  it("the topic is out of setup-pubsub", () => {
    assert.doesNotMatch(PUBSUB, /"financial-data-sync"/);
  });
});

describe("the retired route ACKs rather than NACKs", () => {
  it("answers 200, not 410", () => {
    // Pub/Sub acknowledges only on 102/200/201/202/204. Every other status —
    // including the semantically-correct 410 Gone — is a NACK, so "Gone" would
    // burn all five delivery attempts and raise a dead-letter notification on
    // every retired-job message, weekly, forever. The body says `retired`; the
    // status code is for the transport, which only understands consumed or
    // try-again.
    assert.doesNotMatch(
      ROUTE,
      /,\s*410\s*\)/,
      "route returns 410 — Pub/Sub NACKs",
    );
    assert.match(ROUTE, /retired: true/);
  });

  it("still exists — deleting it would 404, which also NACKs", () => {
    // The schedulers are live until someone runs setup-scheduler.sh. Until then
    // the messages have to land somewhere that consumes them.
    assert.ok(
      existsSync(join(ROOT, "workers/src/routes/financial-data-sync.ts")),
    );
    // The MOUNT specifically, not just the path appearing somewhere. An earlier
    // version matched `/jobs/financial-data-sync` anywhere in the file and was
    // satisfied by the startup ASCII banner, so unmounting the route changed
    // nothing observable — the exact hole this test exists to close.
    assert.match(
      read("workers/src/index.ts"),
      /app\.route\("\/jobs\/financial-data-sync",\s*financialDataSyncRoute\)/,
    );
  });

  it("names its replacements, so the next reader is not left guessing", () => {
    assert.match(ROUTE, /xbrl-projection/);
    assert.match(ROUTE, /xbrl-ratios/);
  });
});

describe("the tier machinery survived the retirement", () => {
  it("lives in core, and exactly once", () => {
    // events-sync needs exactly this population (MONEY-1217: its Yahoo fallback
    // covered 102 symbols against sectors of 238 constituents). Leaving the
    // loader inside a retired processor would have meant importing from a
    // gutted file or duplicating the query.
    //
    // It briefly existed TWICE — lifted into the worker by this ticket and into
    // core by MONEY-1217, because both were built against the same tree
    // concurrently and each avoided racing the other. Core wins: better home,
    // and the more complete module (pure semantics AND the Prisma loader). Two
    // copies of one population query is precisely how five financial writers
    // drifted into five different key maps (MONEY-1205), so the duplicate was
    // deleted rather than kept as a convenience.
    assert.ok(
      existsSync(join(ROOT, "packages/core/src/market-data/sync-tiers.ts")),
      "the shared tier module is missing",
    );
    assert.ok(
      !existsSync(join(ROOT, "workers/src/processors/instrument-tier.ts")),
      "the duplicate tier loader is back",
    );

    const src = read("packages/core/src/market-data/sync-tiers.ts");
    assert.match(src, /export async function loadSyncTierSymbols/);

    // And it must not have picked up a Tickertape dependency on the way out.
    // Comments stripped first: a module that EXPLAINS it moved away from
    // Tickertape would otherwise be flagged for documenting exactly that.
    // LINE before BLOCK (MONEY-1143).
    const code = src
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /tickertape/i);
  });
});

describe("the research READ paths serve what a nightly job stored", () => {
  // The scan above walks `workers/src`, which is what runs on a schedule. That
  // left `packages/research` uncovered, and it is where the request-time twins
  // of the retired job lived: `getOrFetchRatios` and `getOrFetchPeers` both
  // fetched Tickertape on a stale row and UPSERT the result.
  //
  // Both were as doomed as the scheduled job — same 403, same egress — and the
  // write was the worse half. `StockRatios` is @@unique([symbol, exchange]):
  // ONE row per symbol, no period dimension, so a request-time upsert replaces
  // the symbol's entire ratio set with a weaker source's view of it, in a table
  // `xbrl-ratios-daily` now derives 26 of 28 columns of.
  //
  // `getOrFetchPeers` carried a third defect worth keeping named: its create
  // branch fell back to `instrumentId: "000000000000000000000000"` when no
  // instrument resolved — a sentinel pointing at nothing, on a REQUIRED
  // relation, which Prisma throws on rather than returning null. That is
  // MONEY-1216's failure mode manufactured at request time.

  it("db-store imports the Tickertape client NOT AT ALL", () => {
    // Stronger than per-function assertions and much harder to defeat by
    // accident: with no import there is no call to reinstate one line at a
    // time. The mapper helpers in `db-store-logic` are a different module and
    // deliberately stay — they decode rows Tickertape wrote before the
    // switchover.
    assert.doesNotMatch(
      DB_STORE_CODE,
      /from "\.\/tickertape-client"/,
      "db-store.ts imports the Tickertape client again",
    );
  });

  it("neither read path fetches, and neither writes", () => {
    for (const fn of ["getOrFetchRatios", "getOrFetchPeers"]) {
      const at = DB_STORE_CODE.indexOf(`export async function ${fn}(`);
      assert.ok(at > 0, `${fn} not found`);
      const next = DB_STORE_CODE.indexOf("\nexport ", at + 10);
      const body = DB_STORE_CODE.slice(at, next === -1 ? undefined : next);
      assert.doesNotMatch(body, /fetchTickertape/, `${fn} fetches Tickertape`);
      assert.doesNotMatch(
        body,
        /resolveTickertapeSid/,
        `${fn} resolves a Tickertape SID`,
      );
      assert.doesNotMatch(
        body,
        /\.upsert\(|\.update\(|\.create\(/,
        `${fn} writes on a read path`,
      );
    }
  });

  it("the ObjectId sentinel is gone", () => {
    // A row whose required relation points at an id that does not exist takes
    // out every query that selects it, not just its own.
    assert.doesNotMatch(DB_STORE_CODE, /000000000000000000000000/);
  });

  it("a stale row is SERVED, and the reason is logged rather than swallowed", () => {
    // "Stale" stopped being a reason to go anywhere the moment the refresher
    // became a nightly job. A stale real number beats a failed fetch, and beats
    // a silent empty by more — but a caller has to be able to find out.
    assert.match(DB_STORE, /nightly xbrl-ratios job, not this request/);
    assert.match(DB_STORE, /nightly peers-sync job, not this request/);
  });
});

describe("the on-demand research paths do not call a host that blocks us", () => {
  it("the registered financials TOOL reads our store, not the vendor", () => {
    // This tool was registered, offered to the agent every turn, and could not
    // succeed in prod: a 403 came back as `No Tickertape data found for X`,
    // which reads as a fact about the COMPANY rather than about our egress.
    // A tool that cannot succeed is worse than an absent one — the agent spends
    // a turn on it and then reports the wrong conclusion.
    assert.match(FIN_TOOL, /getOrFetchFinancials\(/);
    assert.doesNotMatch(FIN_TOOL, /fetchTickertapeFinancials\(/);
    assert.doesNotMatch(
      FIN_TOOL,
      /from "\.\.\/data-sources\/tickertape-client"/,
    );
  });

  it("the tool's NAME no longer promises a vendor that is not involved", () => {
    // The name is what the model sees when it chooses. A vendor name on a tool
    // that reads our own table will be picked — or skipped — for a reason that
    // is no longer true.
    assert.match(FIN_TOOL, /name: "fetch_financials"/);
    assert.doesNotMatch(FIN_TOOL, /name: "fetch_tickertape_financials"/);
  });

  it("the QUARTERLY chain starts at the source that answers", () => {
    // Removed rather than demoted: a doomed attempt in front of a working one
    // is pure latency on every call. This is the path behind the tab that was
    // empty platform-wide, so it is the one where the wasted round trip cost
    // the most.
    const at = CHAIN.indexOf(
      "export async function fetchQuarterlyResultsChain",
    );
    assert.ok(at > 0, "fetchQuarterlyResultsChain is gone");
    const body = CHAIN.slice(at, CHAIN.indexOf("\nexport ", at + 10));
    assert.doesNotMatch(body, /fetchTickertapeQuarterlyResults/);
    assert.match(body, /fetchScreenerQuarterlyResults/);
  });

  it("names what is still OUTSTANDING rather than implying the vendor is gone", () => {
    // Shareholding and peers still lead with Tickertape and are NOT fixed here:
    // 25 call sites and tests keyed to that leg. Deliberate, ticketed, and said
    // out loud — a half-finished removal that reads as finished is how the
    // financials chain got fixed while its quarterly twin sat broken.
    assert.match(
      CHAIN,
      /fetchTickertapeShareholding|fetchTickertapePeers/,
      "if these are gone too, update this test and MONEY-1228",
    );
  });
});
