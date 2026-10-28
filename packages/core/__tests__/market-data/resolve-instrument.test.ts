/**
 * MONEY-980 — `resolveInstrument`: which queries run, and with what where-clause.
 *
 * The ranking is tested next door in `resolve-instrument-logic.test.ts`. What
 * this file exists for is the half that a pure test cannot reach and that the
 * bug being fixed actually lived in: the OLD call sites' ranking was fine, it
 * was the venue list inside `where` that had gone stale and started matching
 * zero rows by construction. So every assertion here is about the arguments the
 * reader receives and the NUMBER of reads issued.
 *
 * The reader seam is what makes that testable without a database — CI has none.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolveInstrument,
  type IndiaReadArgs,
  type InstrumentReader,
  type UsReadArgs,
} from "../../src/market-data/instruments/resolve-instrument";
import {
  RESOLVE_ROW_LIMIT,
  type IndiaInstrumentRow,
  type UsInstrumentRow,
} from "../../src/market-data/instruments/resolve-instrument-logic";
import {
  SUPPORTED_EXCHANGES,
  US_EXCHANGES,
} from "../../src/market-data/instruments/types";

interface Recorder {
  reader: InstrumentReader;
  indiaCalls: IndiaReadArgs[];
  usCalls: UsReadArgs[];
}

function recorder(
  rows: { india?: IndiaInstrumentRow[]; us?: UsInstrumentRow[] } = {},
): Recorder {
  const indiaCalls: IndiaReadArgs[] = [];
  const usCalls: UsReadArgs[] = [];
  return {
    indiaCalls,
    usCalls,
    reader: {
      async readIndia(args) {
        indiaCalls.push(args);
        return rows.india ?? [];
      },
      async readUs(args) {
        usCalls.push(args);
        return rows.us ?? [];
      },
    },
  };
}

const INDIA_ROW: IndiaInstrumentRow = {
  id: "in-1",
  symbol: "ACC",
  exchange: "NSE",
  name: "ACC Limited",
  yahooSymbol: "ACC.NS",
  instrumentType: "EQUITY",
  isin: "INE012A01025",
  isActive: true,
};

const US_ROW: UsInstrumentRow = {
  id: "us-1",
  listingId: "ACC:NASDAQ:2020-01-01",
  symbol: "ACC",
  exchange: "NASDAQ",
  name: "Atlas Corp",
  assetType: "Stock",
  listingStatus: "ACTIVE",
  listingStartDate: new Date("2020-01-01T00:00:00.000Z"),
};

describe("TWO queries, never N", () => {
  test("a bare symbol issues exactly one read per collection", () => {
    const rec = recorder();
    return resolveInstrument({ symbol: "ACC" }, rec.reader).then(() => {
      assert.equal(rec.indiaCalls.length, 1);
      assert.equal(rec.usCalls.length, 1);
      // The venue count is what a fan-out implementation would multiply by.
      assert.equal(
        rec.indiaCalls.length + rec.usCalls.length,
        2,
        `a per-venue fan-out would be ${SUPPORTED_EXCHANGES.length + US_EXCHANGES.size} reads`,
      );
    });
  });

  test("the two reads are issued CONCURRENTLY, not sequentially", async () => {
    // A `await readIndia(); await readUs();` refactor still issues two reads and
    // would pass every count assertion above. This is the only test that sees
    // the difference: the US read must have STARTED before the India read
    // resolves.
    let releaseIndia: (() => void) | undefined;
    const indiaGate = new Promise<void>((resolve) => {
      releaseIndia = resolve;
    });
    let usStarted = false;

    const reader: InstrumentReader = {
      async readIndia() {
        await indiaGate;
        return [];
      },
      async readUs() {
        usStarted = true;
        return [];
      },
    };

    const pending = resolveInstrument({ symbol: "ACC" }, reader);
    // Yield to the microtask queue so both legs get a chance to start.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      usStarted,
      true,
      "the US read must start before the India read settles",
    );
    releaseIndia?.();
    await pending;
  });

  test('market: "IN" skips the US read entirely', async () => {
    const rec = recorder({ india: [INDIA_ROW] });
    await resolveInstrument({ symbol: "ACC", market: "IN" }, rec.reader);
    assert.equal(rec.indiaCalls.length, 1);
    assert.equal(rec.usCalls.length, 0);
  });

  test('market: "US" skips the India read entirely', async () => {
    const rec = recorder({ us: [US_ROW] });
    await resolveInstrument({ symbol: "ACC", market: "US" }, rec.reader);
    assert.equal(rec.indiaCalls.length, 0);
    assert.equal(rec.usCalls.length, 1);
  });

  test("a US venue hint alone names the market — one read", async () => {
    const rec = recorder({ us: [US_ROW] });
    await resolveInstrument({ symbol: "ACC", exchange: "NASDAQ" }, rec.reader);
    assert.equal(rec.indiaCalls.length, 0);
    assert.equal(rec.usCalls.length, 1);
    assert.equal(rec.usCalls[0]?.exchange, "NASDAQ");
  });

  test("an India venue hint alone names the market — one read, one venue", async () => {
    const rec = recorder({ india: [INDIA_ROW] });
    await resolveInstrument({ symbol: "ACC", exchange: "bse" }, rec.reader);
    assert.equal(rec.usCalls.length, 0);
    assert.deepEqual(rec.indiaCalls[0]?.exchanges, ["BSE"]);
  });
});

describe("zero-query short circuits", () => {
  test("an unparseable symbol reads nothing", async () => {
    for (const symbol of ["", "   ", ".NS"]) {
      const rec = recorder();
      const result = await resolveInstrument({ symbol }, rec.reader);
      assert.equal(
        result.status,
        "NOT_FOUND",
        `symbol ${JSON.stringify(symbol)}`,
      );
      assert.equal(rec.indiaCalls.length + rec.usCalls.length, 0);
    }
  });

  test("an UNKNOWN venue is NOT_FOUND, not a silent widen to both markets", async () => {
    const rec = recorder({ india: [INDIA_ROW], us: [US_ROW] });
    const result = await resolveInstrument(
      { symbol: "ACC", exchange: "LSE" },
      rec.reader,
    );
    assert.equal(result.status, "NOT_FOUND");
    assert.equal(
      rec.indiaCalls.length + rec.usCalls.length,
      0,
      "an unknown venue must not fall back to searching everywhere",
    );
  });

  test("market and venue CONTRADICTING each other reads nothing", async () => {
    const rec = recorder({ india: [INDIA_ROW], us: [US_ROW] });
    const a = await resolveInstrument(
      { symbol: "ACC", market: "IN", exchange: "NASDAQ" },
      rec.reader,
    );
    const b = await resolveInstrument(
      { symbol: "ACC", market: "US", exchange: "NSE" },
      rec.reader,
    );
    assert.equal(a.status, "NOT_FOUND");
    assert.equal(b.status, "NOT_FOUND");
    assert.equal(rec.indiaCalls.length + rec.usCalls.length, 0);
  });

  test("market and venue AGREEING is not treated as a contradiction", async () => {
    const rec = recorder({ us: [US_ROW] });
    const result = await resolveInstrument(
      { symbol: "ACC", market: "US", exchange: "NASDAQ" },
      rec.reader,
    );
    assert.equal(result.status, "RESOLVED");
    assert.equal(rec.usCalls.length, 1);
  });
});

describe("the India where-clause — the regression this module exists for", () => {
  test("the default venue scope is EVERY India venue and NO US venue", async () => {
    const rec = recorder();
    await resolveInstrument({ symbol: "ACC" }, rec.reader);
    const exchanges = rec.indiaCalls[0]?.exchanges ?? [];
    assert.deepEqual([...exchanges], [...SUPPORTED_EXCHANGES]);
    for (const venue of exchanges) {
      assert.ok(
        !US_EXCHANGES.has(venue),
        `${venue} is a US venue and matches ZERO rows of instrument_mappings — ` +
          "this is exactly the stale hand-typed list the resolver replaces",
      );
    }
  });

  test("the India scope is never empty", async () => {
    // An empty `in: []` matches nothing on Mongo, which would turn every India
    // lookup into a silent NOT_FOUND.
    const rec = recorder();
    await resolveInstrument({ symbol: "ACC" }, rec.reader);
    assert.ok((rec.indiaCalls[0]?.exchanges.length ?? 0) > 0);
  });

  test("the normalized symbol is what reaches BOTH reads", async () => {
    const rec = recorder();
    await resolveInstrument({ symbol: "  reliance.ns " }, rec.reader);
    assert.equal(rec.indiaCalls[0]?.symbol, "RELIANCE");
    assert.equal(rec.usCalls[0]?.symbol, "RELIANCE");
  });
});

describe("liveness reaches both reads", () => {
  test("liveOnly is TRUE by default on both collections", async () => {
    const rec = recorder();
    await resolveInstrument({ symbol: "ACC" }, rec.reader);
    assert.equal(rec.indiaCalls[0]?.liveOnly, true);
    assert.equal(rec.usCalls[0]?.liveOnly, true);
  });

  test("includeInactive widens BOTH, not just one", async () => {
    const rec = recorder();
    await resolveInstrument(
      { symbol: "ACC", includeInactive: true },
      rec.reader,
    );
    assert.equal(rec.indiaCalls[0]?.liveOnly, false);
    assert.equal(rec.usCalls[0]?.liveOnly, false);
  });

  test("includeInactive: false is the same as omitting it", async () => {
    const rec = recorder();
    await resolveInstrument(
      { symbol: "ACC", includeInactive: false },
      rec.reader,
    );
    assert.equal(rec.indiaCalls[0]?.liveOnly, true);
    assert.equal(rec.usCalls[0]?.liveOnly, true);
  });

  test("a delisted-only US ticker is found only with includeInactive", async () => {
    const dead: UsInstrumentRow = {
      ...US_ROW,
      symbol: "LEH",
      listingId: "LEH:NYSE:1994-01-01",
      exchange: "NYSE",
      name: "Lehman Brothers",
      listingStatus: "DELISTED",
    };
    // The reader stands in for the DB filter: liveOnly returns nothing.
    const reader: InstrumentReader = {
      async readIndia() {
        return [];
      },
      async readUs(args) {
        return args.liveOnly ? [] : [dead];
      },
    };
    assert.equal(
      (await resolveInstrument({ symbol: "LEH" }, reader)).status,
      "NOT_FOUND",
    );
    const widened = await resolveInstrument(
      { symbol: "LEH", includeInactive: true },
      reader,
    );
    assert.equal(widened.status, "RESOLVED");
    if (widened.status !== "RESOLVED") return;
    assert.equal(widened.instrument.active, false);
    assert.equal(widened.instrument.name, "Lehman Brothers");
  });
});

describe("end-to-end through the seam", () => {
  test("a collision resolves India and discloses the US listing", async () => {
    const rec = recorder({ india: [INDIA_ROW], us: [US_ROW] });
    const result = await resolveInstrument({ symbol: "ACC" }, rec.reader);
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.market, "IN");
    assert.equal(result.instrument.yahooSymbol, "ACC.NS");
    assert.equal(result.alternatives[0]?.market, "US");
  });

  test('market: "US" on a collision returns the US row', async () => {
    const rec = recorder({ india: [INDIA_ROW], us: [US_ROW] });
    const result = await resolveInstrument(
      { symbol: "ACC", market: "US" },
      rec.reader,
    );
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.market, "US");
    assert.equal(result.instrument.listingId, "ACC:NASDAQ:2020-01-01");
  });

  test("a database error PROPAGATES — it must never read as NOT_FOUND", async () => {
    // Fail-open is the shape this repo has a standing rule against: a swallowed
    // error would tell a user their ticker does not exist during an outage.
    const reader: InstrumentReader = {
      async readIndia() {
        throw new Error("connection reset");
      },
      async readUs() {
        return [];
      },
    };
    await assert.rejects(
      () => resolveInstrument({ symbol: "ACC" }, reader),
      /connection reset/,
    );
  });
});

describe("the production reader's shape is pinned by source", () => {
  // `defaultInstrumentReader` is the one thing here that cannot run without a
  // database, so its where-clause is checked structurally — the same technique
  // `india-surface-market-scope.test.ts` uses for the discover surfaces.
  const SRC = new URL(
    "../../src/market-data/instruments/resolve-instrument.ts",
    import.meta.url,
  );

  /**
   * Comments STRIPPED before scanning. This file's header deliberately quotes
   * the forbidden `{ not: "DELISTED" }` spelling to explain why it is
   * forbidden — a scan over raw text would fail on its own documentation, and
   * the obvious "fix" (deleting the explanation) is the wrong one.
   *
   * LINE comments FIRST, then BLOCK — never the reverse (MONEY-1143). A `//`
   * comment containing an opening block marker starts a phantom block that
   * swallows every line up to the next terminator, and since the assertions
   * below are ABSENCE checks, the swallowed code reads as a PASS.
   * `apps/web/__tests__/meta/comment-strip-ordering.test.ts` enforces this
   * repo-wide, and it caught this file.
   */
  async function code(): Promise<string> {
    const fs = await import("node:fs/promises");
    return (await fs.readFile(SRC, "utf8"))
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
  }

  test("the comment stripper leaves the real code behind", async () => {
    // Without this, a stripper that deleted everything would make every
    // assertion below vacuously true.
    const src = await code();
    assert.ok(src.includes("prisma.usInstrument.findMany"));
    assert.ok(src.includes("prisma.instrumentMapping.findMany"));
    assert.ok(!src.includes("MONEY-980"), "block comments should be gone");
  });

  test("liveness is matched POSITIVELY on both collections", async () => {
    const src = await code();
    assert.ok(
      !/not:\s*"DELISTED"/.test(src),
      '`{ not: "DELISTED" }` matches ZERO against a Mongo-absent attribute',
    );
    assert.ok(
      !/isActive:\s*\{\s*not:/.test(src),
      "`{ isActive: { not: false } }` matches ZERO against an absent attribute",
    );
    assert.ok(/listingStatus:\s*\{\s*\n?\s*in:/.test(src));
  });

  test("both reads are BOUNDED by RESOLVE_ROW_LIMIT", async () => {
    const src = await code();
    const takes = src.match(/take:\s*RESOLVE_ROW_LIMIT/g) ?? [];
    assert.equal(
      takes.length,
      2,
      "an unbounded findMany reads every row of a pathological ticker",
    );
    assert.equal(typeof RESOLVE_ROW_LIMIT, "number");
  });
});

/**
 * MONEY-980 — the free-text call sites must NAME their market.
 *
 * A STRUCTURAL test, for the same reason `india-surface-market-scope.test.ts`
 * is one: the failure needs no bug to appear. `resolveInstrument`'s default is
 * "consult both markets, India wins a TIE", which is right for a caller that
 * has a security in mind and wrong for a caller holding a token it scraped out
 * of a sentence — because for that caller "India returned nothing" is the
 * ORDINARY case, not a tie, and the US collection then wins outright.
 *
 * Both sites below run an India ladder whose FIRST rung returns early, so an
 * unscoped call answers any bare token that is an active US ticker before the
 * company-NAME rungs — the ones that turn "INFOSYS" into INFY — ever run. That
 * regression shipped once already, behind no flag.
 *
 * Executed behaviour lives next door: `market: "IN" skips the US read
 * entirely` proves what the flag DOES. This proves the call sites pass it.
 */
describe("free-text symbol resolution is scoped to India", () => {
  /** Repo root: __tests__/market-data -> __tests__ -> core -> packages -> root. */
  const REPO_ROOT = new URL("../../../../", import.meta.url);

  /**
   * Every site that hands `resolveInstrument` a token lifted out of free text
   * (a chat message) or out of an LLM planner's output.
   */
  const FREE_TEXT_SITES = [
    "apps/web/app/api/chat/route.ts",
    "packages/research/src/agent.ts",
  ] as const;

  /**
   * LINE comments first, then BLOCK — never the reverse (MONEY-1143). Both
   * files now DOCUMENT the rule below in prose, quoting `market: "IN"` and the
   * dead `["NSE","BSE","NASDAQ","NYSE","AMEX"]` list, so a scan over raw text
   * would pass on the documentation and never look at the code.
   */
  function strip(src: string): string {
    return src
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
  }

  async function read(rel: string): Promise<string> {
    const fs = await import("node:fs/promises");
    return strip(await fs.readFile(new URL(rel, REPO_ROOT), "utf8"));
  }

  /** Every `name(` ... matching `)` slice in `src`, parens balanced. */
  function callsTo(src: string, name: string): string[] {
    const out: string[] = [];
    const re = new RegExp(`${name}\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      out.push(src.slice(m.index, i));
    }
    return out;
  }

  test("the sites exist and the stripper leaves their code behind", async () => {
    // A blind scan proves nothing, and a stripper that deleted everything would
    // make every ABSENCE assertion below vacuously true.
    for (const rel of FREE_TEXT_SITES) {
      const src = await read(rel);
      assert.ok(src.length > 1000, `${rel} stripped to nothing`);
      assert.ok(
        src.includes("resolveInstrument"),
        `${rel} lost its resolver call to the stripper`,
      );
      assert.ok(
        !src.includes("MONEY-980"),
        `${rel}: block comments should be gone`,
      );
    }
  });

  test("the scan FINDS the resolver calls it is meant to police", async () => {
    // Without this, renaming or deleting the call sites would leave the suite
    // green while the rule went unenforced.
    let found = 0;
    for (const rel of FREE_TEXT_SITES) {
      const calls = callsTo(await read(rel), "resolveInstrument");
      assert.ok(calls.length > 0, `${rel}: no resolveInstrument call found`);
      found += calls.length;
    }
    assert.ok(found >= FREE_TEXT_SITES.length, `only ${found} calls matched`);
  });

  test('EVERY free-text call passes market: "IN"', async () => {
    const offenders: string[] = [];
    for (const rel of FREE_TEXT_SITES) {
      for (const call of callsTo(await read(rel), "resolveInstrument")) {
        if (!/market:\s*"IN"/.test(call)) {
          offenders.push(`${rel}: ${call.replace(/\s+/g, " ")}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "an unscoped call lets an active US ticker preempt India's name branches",
    );
  });

  test("no site queries a US venue against instrument_mappings", async () => {
    // The stale hand-typed list. Since the split these terms match ZERO ROWS BY
    // CONSTRUCTION, so their only effect is to read as US coverage.
    for (const rel of FREE_TEXT_SITES) {
      const src = await read(rel);
      for (const venue of ["NASDAQ", "NYSE", "AMEX"]) {
        assert.ok(
          !src.includes(`"${venue}"`),
          `${rel} still names ${venue} — instrument_mappings holds no such row`,
        );
      }
    }
  });

  test("company-NAME queries scope to the shared cash-venue list", async () => {
    // Not a hand-typed ["NSE","BSE"], and NOT the full venue RANK: NFO/BFO/MCX
    // `name` values are contract identifiers, so including them resolves a
    // company query to a derivative.
    let nameQueries = 0;
    for (const rel of FREE_TEXT_SITES) {
      const src = await read(rel);
      const uses = (src.match(/INDIA_CASH_VENUES/g) ?? []).length;
      assert.ok(uses > 0, `${rel} does not use INDIA_CASH_VENUES`);
      // One import + at least one query.
      assert.ok(
        uses >= 2,
        `${rel} imports INDIA_CASH_VENUES but never queries it`,
      );
      nameQueries += uses - 1;
      assert.ok(
        !/exchange:\s*\{\s*in:\s*\[\s*"NSE"/.test(src),
        `${rel} still hand-types its venue list`,
      );
      assert.ok(
        !/exchange:\s*\{\s*in:\s*\[\s*\.\.\.INDIA_VENUE_ORDER/.test(src),
        `${rel} scopes a NAME query to the full venue RANK, which includes ` +
          "NFO/BFO/MCX — those rows carry contract names, not company names",
      );
    }
    assert.ok(nameQueries >= 2, `only ${nameQueries} name queries scoped`);
  });

  test("every paged name query is ORDERED", async () => {
    // A `take` with no `orderBy` returns an arbitrary N of the matching rows,
    // so an in-memory "best match" picks the best of a page nobody chose and
    // two identical runs can disagree.
    const offenders: string[] = [];
    for (const rel of FREE_TEXT_SITES) {
      const src = await read(rel);
      for (const call of callsTo(src, "instrumentMapping\\.findMany")) {
        if (/take:/.test(call) && !/orderBy:/.test(call)) {
          offenders.push(`${rel}: ${call.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "an unordered `take` is an arbitrary page");
  });
});
