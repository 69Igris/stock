/**
 * The F3 reconcile must read `xbrl_filings` in SYMBOL PAGES — MONEY-1287.
 *
 * ## The measured failure
 *
 * `scripts/data/xbrl-reconcile.ts` issued ONE `prisma.xbrlFiling.findMany()`
 * over the whole table, with no `take` unless `--limit` was passed, selecting
 * `facts: true` — the parsed filing, and the largest column in the table.
 * Measured on prod 2026-08-30:
 *
 *     collStats xbrl_filings   625,101,389 bytes   108,020 docs   avgObjSize 5,786
 *
 * Prisma's Rust engine serialises a result set into ONE JSON string and hands
 * it across the napi boundary, and a V8 string has a hard length ceiling
 * (`buffer.constants.MAX_STRING_LENGTH`, ~536 MB on 64-bit). So the run did not
 * get slower, it ABORTED before comparing anything:
 *
 *     ./scripts/ops/run-market-data-job.sh xbrlrecon prod
 *     Invalid `prisma.xbrlFiling.findMany()` invocation at xbrl-reconcile.ts:718:43
 *     Failed to convert rust `String` into napi `string`   → EXIT=1
 *
 * `docs/reference/xbrl-switchover-runbook.md:168` says a non-zero exit from
 * this gate means **"we compared nothing"**, which must never be read as
 * "everything matched". So the documented arming PRECONDITION for the entire
 * XBRL switchover — the one-way door after which `StockFinancials` has no
 * second copy of the vendor value to reconcile against — was simply
 * un-runnable. Only `--limit=20000` completed, and that is 471 of ~2,467 annual
 * symbols. It degrades further on its own as the backfill grows.
 *
 * ## Why this file asserts what it asserts
 *
 * The dangerous fix here is a fix that changes the ANSWER. Paging a read is
 * only safe if the rows a caller sees, and the order it sees them in, are
 * identical to the single unbounded fetch — so both halves are pinned, and each
 * one alone is worthless:
 *
 *   1. ROUND-TRIP COUNT. `findMany` must be called once per page (plus one
 *      symbol census), never once for the whole population. Without this the
 *      paging can silently collapse back to a single unbounded read while every
 *      value assertion stays green — which is the exact state the file was in
 *      before this ticket.
 *   2. OUTPUT IDENTITY, against an ORACLE rather than golden values. Every
 *      scenario runs the shipped `readFilingsBySymbolPage` AND the pre-change
 *      single-shot query (`singleShot` below — a verbatim port of the old
 *      `findMany` args) against the SAME injected table, then asserts the
 *      concatenated pages deep-equal the single fetch and that a per-field
 *      TALLY accumulated page-by-page equals the tally accumulated in one go.
 *      Golden row counts are asserted too, so the pair cannot drift together
 *      into being wrong.
 *
 * MUTATION-VERIFIED, both directions, each applied to source, confirmed RED,
 * then reverted byte-identically:
 *
 *   - `readFilingsBySymbolPage`'s page loop replaced by a single unbounded
 *     `delegate.findMany({ where, orderBy, select })` — the literal "restore
 *     the single unbounded findMany". `stats.pages` becomes 1 and
 *     "issues one findMany per page of symbols" goes red.
 *   - `main()`'s call to `readFilingsBySymbolPage` replaced by the original
 *     `prisma.xbrlFiling.findMany({ ... })`. The behavioural cases stay green —
 *     they drive the exported function directly — and "main() reads through the
 *     pager, not through a bare findMany" goes red. That is the JOIN: an
 *     exported helper nothing calls is a fix that shipped disarmed.
 *
 * The injected double stores its rows SHUFFLED, so any path that stops asking
 * the database to sort — or sorts by the wrong key — produces different page
 * boundaries and fails. A double that handed back pre-sorted rows would make
 * the ordering untestable.
 *
 * Source: scripts/data/xbrl-reconcile.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The script's own pager, driven directly.
 *
 * Importable at all because `xbrl-reconcile.ts` now calls `main()` ONLY when it
 * is the process entry point — an unguarded call would open a database
 * connection the moment this file imported it, and on a machine with no
 * `DATABASE_URL` its `.catch` would `process.exit(1)` and take the whole test
 * process with it. That this file runs to completion IS the proof the guard
 * works; there is no separate case for it because a broken guard cannot produce
 * a passing suite.
 *
 * A DYNAMIC import, and it has to be — the same boundary
 * `us-fundamentals/coverage-gate.test.ts` documents. `packages/core` is
 * `"type": "module"` while the repo root, and therefore `scripts/`, is not, so
 * tsx transpiles the script to CommonJS; a static
 * `import { readFilingsBySymbolPage } from …` resolves the file and then throws
 * `does not provide an export named …` at load time. Do not "tidy" this back
 * into a static import.
 */
const { readFilingsBySymbolPage, SYMBOL_PAGE_SIZE } =
  await import("../../../../scripts/data/xbrl-reconcile");

/** CWD is `packages/core` when this suite runs. */
const ROOT = join(process.cwd(), "..", "..");
const RECONCILE_SRC = readFileSync(
  join(ROOT, "scripts", "data", "xbrl-reconcile.ts"),
  "utf8",
);

/** LINE comments before BLOCK comments — MONEY-1143. */
const strip = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const RECONCILE = strip(RECONCILE_SRC);

// ════════════════════════════════════════════════════════════════════════════
// The double
// ════════════════════════════════════════════════════════════════════════════

interface FilingLike {
  id: string;
  symbol: string;
  exchange: string;
  periodEnd: Date;
  basis: string;
  /** Stands in for the 5,786-byte column that could not cross napi. */
  facts: { revenue: number };
}

/**
 * A row as the double PROJECTS it — the pager's `Row` type parameter.
 *
 * An index signature rather than a concrete row type, because the census
 * projects `{symbol}` only while a page projects all six columns, and the whole
 * safety property being tested is that those two shapes come back from the same
 * delegate. `symbol` is the one key that must always be there — it is the paging
 * key — and it is required here for exactly that reason.
 */
interface ProjectedRow {
  symbol: string;
  [key: string]: unknown;
}

/** The columns the gate selects, in the shape the pager is handed them. */
const SELECT: Record<string, boolean> = {
  id: true,
  symbol: true,
  exchange: true,
  periodEnd: true,
  basis: true,
  facts: true,
};

/**
 * A deterministic shuffle. Seeded, not `Math.random`, so a failure reproduces.
 *
 * The rows MUST arrive out of order: the whole safety argument for paging by
 * symbol is that `orderBy: [{symbol: asc}, {periodEnd: desc}]` makes the
 * concatenation of pages equal the single global fetch. A pre-sorted fixture
 * would satisfy that by accident.
 */
function shuffle<T>(rows: T[], seed: number): T[] {
  const out = [...rows];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * `N` symbols, each with `perSymbol` filings on descending period ends.
 *
 * Symbol names are zero-padded so lexical order is unambiguous — `SYM9` vs
 * `SYM10` would sort in a way that hides an ordering bug behind plausible
 * output.
 */
function makeTable(n: number, perSymbol: number): FilingLike[] {
  const rows: FilingLike[] = [];
  for (let s = 0; s < n; s++) {
    const symbol = `SYM${String(s).padStart(4, "0")}`;
    for (let p = 0; p < perSymbol; p++) {
      rows.push({
        id: `${symbol}-${p}`,
        symbol,
        exchange: "NSE",
        // Two bases on the newest year for a third of the symbols, so a page
        // boundary that split a sibling pair would change which filing wins.
        periodEnd: new Date(Date.UTC(2025 - p, 2, 31)),
        basis: s % 3 === 0 && p === 0 ? "STANDALONE" : "CONSOLIDATED",
        facts: { revenue: s * 1000 + p },
      });
    }
  }
  return shuffle(rows, 7);
}

interface Recorded {
  where: Record<string, unknown>;
  select: Record<string, boolean>;
  distinct?: readonly string[];
  take?: number;
  orderBy?: unknown;
}

/**
 * A `prisma.xbrlFiling`-shaped double that records every `findMany`.
 *
 * It implements only what the pager uses — a `symbol: { in: [...] }` filter,
 * `distinct`, `take`, the two orderings and the projection — and it applies
 * them in Mongo's order (filter, sort, distinct, take, project), because the
 * `--limit` identity depends on `take` being applied AFTER the sort.
 */
function makeDelegate(rows: FilingLike[]) {
  const calls: Recorded[] = [];
  const delegate = {
    async findMany(args: Recorded): Promise<ProjectedRow[]> {
      calls.push(args);
      const where = args.where ?? {};
      let out = [...rows];
      const symbolFilter = where["symbol"] as { in?: string[] } | undefined;
      if (symbolFilter?.in !== undefined) {
        const wanted = new Set(symbolFilter.in);
        out = out.filter((r) => wanted.has(r.symbol));
      }
      // HONOURS `args.orderBy` — it used to hardcode symbol-asc / periodEnd-desc
      // and ignore the argument entirely, which made the header's claim above
      // ("any path that ... sorts by the wrong key ... fails") measurably
      // false. The double sorted correctly no matter what the code asked for,
      // so shuffling the stored rows proved nothing: flipping
      // `periodEnd: "desc"` to `"asc"` in the source left 12/12 green.
      //
      // No `orderBy` now means NO SORT, i.e. the shuffled storage order — so a
      // path that stops asking the database to sort fails too, which is the
      // other half the old double silently supplied.
      const orderBy = (args.orderBy ?? []) as Record<string, "asc" | "desc">[];
      if (orderBy.length > 0) {
        out.sort((a, b) => {
          for (const clause of orderBy) {
            for (const [field, dir] of Object.entries(clause)) {
              const av = (a as unknown as Record<string, unknown>)[field];
              const bv = (b as unknown as Record<string, unknown>)[field];
              const an = av instanceof Date ? av.getTime() : av;
              const bn = bv instanceof Date ? bv.getTime() : bv;
              if (an === bn) continue;
              const cmp = (an as never) < (bn as never) ? -1 : 1;
              return dir === "desc" ? -cmp : cmp;
            }
          }
          return 0;
        });
      }
      if (args.distinct !== undefined) {
        const seen = new Set<string>();
        out = out.filter((r) => {
          if (seen.has(r.symbol)) return false;
          seen.add(r.symbol);
          return true;
        });
      }
      if (typeof args.take === "number") out = out.slice(0, args.take);
      const keys = Object.keys(args.select).filter((k) => args.select[k]);
      // The cast is the projection itself: `Object.fromEntries` cannot know
      // that `symbol` survives, and every `select` the pager issues includes it.
      return out.map(
        (r) =>
          Object.fromEntries(
            keys.map((k) => [k, (r as unknown as Record<string, unknown>)[k]]),
          ) as ProjectedRow,
      );
    },
  };
  return { delegate, calls };
}

/**
 * The read exactly as it was BEFORE this ticket — the oracle.
 *
 * A verbatim port of the deleted `findMany` args, not a re-derivation: it is
 * only an oracle if it is the thing being replaced.
 */
async function singleShot(
  delegate: ReturnType<typeof makeDelegate>["delegate"],
  where: Record<string, unknown>,
  limit: number,
): Promise<ProjectedRow[]> {
  return delegate.findMany({
    where,
    orderBy: [{ symbol: "asc" }, { periodEnd: "desc" }],
    select: SELECT,
    ...(limit ? { take: limit } : {}),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// The tally — what the gate actually accumulates
// ════════════════════════════════════════════════════════════════════════════

/**
 * A stand-in for the gate's per-field accumulation.
 *
 * The point of the ticket is that tallies survive being fed a page at a time,
 * so the shape mirrors the real ones: counters that must sum across pages, and
 * a Map keyed by something symbol-scoped that must not be reset per page. If a
 * page-local declaration crept back in, `bySymbol.size` here would report the
 * LAST page's symbols — which is precisely how `incumbents.size` would have
 * mis-reported the QA shape over a full prod run.
 */
interface Tally {
  rows: number;
  revenueTotal: number;
  bySymbol: Map<string, number>;
  firstRowId: string | undefined;
  lastRowId: string | undefined;
}

function emptyTally(): Tally {
  return {
    rows: 0,
    revenueTotal: 0,
    bySymbol: new Map(),
    firstRowId: undefined,
    lastRowId: undefined,
  };
}

function accumulate(t: Tally, page: ProjectedRow[]): void {
  for (const r of page) {
    const symbol = r.symbol;
    const facts = r["facts"] as { revenue: number };
    t.rows += 1;
    t.revenueTotal += facts.revenue;
    t.bySymbol.set(symbol, (t.bySymbol.get(symbol) ?? 0) + 1);
    t.firstRowId ??= r["id"] as string;
    t.lastRowId = r["id"] as string;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Cases
// ════════════════════════════════════════════════════════════════════════════

describe("the F3 reconcile reads xbrl_filings in symbol pages", () => {
  it("issues one findMany per page of symbols, never one for the table", async () => {
    // THE assertion the ticket exists for. 47 symbols at a page size of 5 is
    // 10 pages; the unbounded read this replaces would be 1.
    const table = makeTable(47, 3);
    const { delegate, calls } = makeDelegate(table);

    const stats = await readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 5 },
      () => {},
    );

    assert.equal(stats.symbols, 47);
    assert.equal(stats.filings, 47 * 3);
    assert.ok(
      stats.pages >= Math.ceil(47 / 5),
      `expected at least ${Math.ceil(47 / 5)} pages, got ${stats.pages} — a ` +
        "single unbounded findMany is the defect this pins",
    );
    assert.equal(stats.pages, Math.ceil(47 / 5));
    // One census call on top of the pages, and nothing else.
    assert.equal(calls.length, stats.pages + 1);
  });

  it("never asks for `facts` when it is only counting symbols", () => {
    // The census is the one query that runs over the WHOLE population, so it is
    // the one query that must not carry the 5,786-byte column. Reusing
    // `opts.select` here would look like a tidy-up and would reintroduce the
    // napi ceiling in the very call added to avoid it.
    const table = makeTable(12, 2);
    const { delegate, calls } = makeDelegate(table);

    return readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 5 },
      () => {},
    ).then(() => {
      const census = calls[0];
      assert.ok(census, "no census query was issued");
      assert.deepEqual(census.select, { symbol: true });
      assert.deepEqual(census.distinct, ["symbol"]);
      assert.equal(census.take, undefined);
    });
  });

  it("hands the caller exactly the rows the single unbounded read did", async () => {
    const table = makeTable(23, 4);
    const { delegate } = makeDelegate(table);

    const oracle = await singleShot(delegate, {}, 0);
    const pages: ProjectedRow[][] = [];
    const stats = await readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 4 },
      (page) => {
        pages.push(page);
      },
    );

    // Golden, so oracle and implementation cannot drift together into agreeing
    // on the wrong number.
    assert.equal(oracle.length, 23 * 4);
    assert.equal(stats.filings, 23 * 4);
    // Identity, including ORDER. This is what makes `selectFilingForPeriod`
    // safe across a page boundary.
    assert.deepEqual(pages.flat(), oracle);
    assert.ok(pages.length > 1, "the fixture must actually span pages");
  });

  it("accumulates page-by-page to the same tallies as one fetch", async () => {
    const table = makeTable(31, 3);
    const { delegate } = makeDelegate(table);

    const paged = emptyTally();
    await readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 7 },
      (page) => accumulate(paged, page),
    );

    const oneShot = emptyTally();
    accumulate(oneShot, await singleShot(delegate, {}, 0));

    assert.deepEqual(paged, oneShot);
    // Golden, so the two are not equal because both are empty.
    assert.equal(oneShot.rows, 31 * 3);
    assert.equal(oneShot.bySymbol.size, 31);
  });

  it("keeps every symbol's filings inside ONE page", async () => {
    // MONEY-1232 lives or dies here. A page that splits a symbol can cut
    // between a STANDALONE filing and the CONSOLIDATED sibling that supersedes
    // it, handing the period to the loser — the same defect the symbol-major
    // ordering was introduced to prevent, reintroduced by the paging instead of
    // by the ordering.
    const table = makeTable(17, 5);
    const { delegate } = makeDelegate(table);

    const pages: ProjectedRow[][] = [];
    await readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 4 },
      (page) => {
        pages.push(page);
      },
    );

    const seen = new Map<string, number>();
    for (const [i, page] of pages.entries()) {
      const symbols = new Set(page.map((r) => r.symbol));
      assert.ok(symbols.size <= 4, `page ${i} carried ${symbols.size} symbols`);
      for (const s of symbols) {
        assert.equal(
          seen.has(s),
          false,
          `${s} appeared in page ${seen.get(s)} and again in page ${i}`,
        );
        seen.set(s, i);
      }
      // Every filing a symbol has, or the sibling tie-break sees a subset.
      for (const s of symbols) {
        assert.equal(
          page.filter((r) => r.symbol === s).length,
          5,
          `${s} was split across pages`,
        );
      }
    }
    assert.equal(seen.size, 17);
  });

  it("spends --limit across pages, cutting the same symbol-major prefix", async () => {
    // `--limit` is the smoke-run affordance the runbook's scoped pilot uses, so
    // it has to keep meaning what it meant: a cap on FILINGS over a symbol-major
    // ordering, which can only ever cut INSIDE one symbol.
    const table = makeTable(20, 3);
    const { delegate, calls } = makeDelegate(table);

    const oracle = await singleShot(delegate, {}, 14);
    const before = calls.length;

    const pages: ProjectedRow[][] = [];
    const stats = await readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 3, limit: 14 },
      (page) => {
        pages.push(page);
      },
    );

    assert.equal(oracle.length, 14);
    assert.equal(stats.filings, 14);
    assert.deepEqual(pages.flat(), oracle);
    // It STOPS. 20 symbols at 3 per page is 7 pages unbounded; 14 filings is
    // reached inside the fifth, so a limit that did not short-circuit would
    // keep paying for pages nobody reads.
    assert.ok(
      stats.pages < Math.ceil(20 / 3),
      `--limit did not stop the loop early (${stats.pages} pages)`,
    );
    assert.equal(calls.length - before, stats.pages + 1);
  });

  it("narrows a --symbols= filter per page instead of widening it", async () => {
    // The batch is drawn from a census that already applied the caller's own
    // `where`, so `{ ...where, symbol: { in: batch } }` can only ever be a
    // subset. Pinned because the spread order is what makes that true, and a
    // reordering would silently turn `--symbols=TCS` into a whole-table run.
    const table = makeTable(9, 2);
    const { delegate, calls } = makeDelegate(table);
    const where = { symbol: { in: ["SYM0001", "SYM0003", "SYM0007"] } };

    const pages: ProjectedRow[][] = [];
    const stats = await readFilingsBySymbolPage(
      delegate,
      { where, select: SELECT, pageSize: 2 },
      (page) => {
        pages.push(page);
      },
    );

    assert.equal(stats.symbols, 3);
    assert.equal(stats.filings, 6);
    assert.deepEqual(pages.flat(), await singleShot(delegate, where, 0));
    for (const call of calls.slice(1)) {
      const asked = (call.where["symbol"] as { in: string[] }).in;
      for (const s of asked) {
        assert.ok(
          where.symbol.in.includes(s),
          `page asked for ${s}, which the caller's filter excludes`,
        );
      }
    }
  });

  it("reports an empty population rather than an empty page", async () => {
    // The gate's own warning — "NO XbrlFiling rows matched … this is NOT a
    // passing reconciliation" — keys on the returned count, so a pager that
    // invented a page of zero rows would route a missing backfill into the
    // normal report and print a clean ladder over nothing.
    const { delegate } = makeDelegate([]);
    let pagesSeen = 0;

    const stats = await readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 5 },
      () => {
        pagesSeen += 1;
      },
    );

    assert.equal(stats.filings, 0);
    assert.equal(stats.symbols, 0);
    assert.equal(stats.pages, 0);
    assert.equal(pagesSeen, 0);
  });

  it("defaults to whole-population paging, not to a cap", async () => {
    // The runbook's arming precondition is a FULL run. A default `limit` would
    // make the gate pass over a sample while reading like a census — the
    // draining-denominator failure (MONEY-1196) at the read layer.
    const table = makeTable(9, 2);
    const { delegate } = makeDelegate(table);

    const stats = await readFilingsBySymbolPage(
      delegate,
      { where: {}, select: SELECT, pageSize: 4 },
      () => {},
    );

    assert.equal(stats.filings, 18);
    assert.equal(SYMBOL_PAGE_SIZE, 200);
  });
});

describe("the pager is WIRED — main() cannot go back to one unbounded read", () => {
  it("main() reads through the pager, not through a bare findMany", () => {
    // THE JOIN. Every case above drives the exported function directly, so all
    // of them stay green if `main()` quietly keeps its original query and the
    // pager becomes dead code — "merged ≠ wired", which cost MONEY-1220 a
    // release. There must be exactly one filings read and it must be the pager.
    assert.match(RECONCILE, /await readFilingsBySymbolPage\(/);
    assert.doesNotMatch(
      RECONCILE,
      /prisma\.xbrlFiling\.findMany\(/,
      "xbrl-reconcile.ts issues a direct prisma.xbrlFiling.findMany again — " +
        "that is the 625 MB read that could not cross the napi boundary",
    );
  });

  it("keeps the symbol-major ordering the sibling tie-break depends on", () => {
    // Also asserted by `reconcile-gate-population.test.ts`; repeated here
    // because the ordering moved INTO the pager, and a guard that lives only in
    // the file the code left is a guard that stopped guarding.
    assert.match(RECONCILE, /orderBy:\s*\[\{\s*symbol:\s*"asc"\s*\}/);
  });

  it("runs main() only as an entry point, so importing it opens no connection", () => {
    // The mechanism this whole file rests on. Written as a source assertion as
    // well as relied on implicitly, because the implicit proof — that the suite
    // ran at all — reads as unrelated if the guard is ever deleted: the failure
    // would be a `process.exit(1)` inside an unrelated import, hundreds of
    // lines from the cause.
    assert.match(RECONCILE, /pathToFileURL\(process\.argv\[1\]\)\.href/);
    assert.match(RECONCILE, /if \(invokedDirectly\) \{\s*main\(\)/);
  });
});
