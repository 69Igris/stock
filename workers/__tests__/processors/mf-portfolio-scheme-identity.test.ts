/**
 * Scheme identity, the discovery glue, and the composition cache.
 * MONEY-1401 finding 8b + MONEY-1294 (writer half) + MONEY-1405 residual.
 *
 * ## The three defects
 *
 * **8b — the master index was not scoped by AMC.** `buildMasterSchemeIndexOrNull`
 * built one industry-wide map from all 14,225 `mutual_fund_masters` rows and
 * looked names up in it with no reference to the house that printed them, while
 * `amfi-scheme-bridge`'s whole stated purpose is "narrow the name match from
 * 14,273 industry-wide rows to one AMC's list". `codes.size === 1` closes the
 * COLLISION case and says nothing about OWNERSHIP: a printed name matching
 * exactly one master row AT ANOTHER HOUSE yielded a confident, wrong code, and
 * a wrong code attributes one fund's holdings to another with nothing
 * downstream able to see it. Not hypothetical for every house — ICICI's scheme
 * names come from a zip-member FILENAME, which need not name the house at all.
 *
 * **MONEY-1294 — the array had no writer.** The column, both indexes, the
 * reader's `OR` and the reader's test all shipped; the write did not.
 * `amfiSchemeCodes` was non-empty on 0 of 54,248 prod rows and would have
 * stayed that way, because the caller discarded `res.schemeCodes` whenever the
 * family held more than one code — which is 414 of the 534 matched schemes.
 *
 * **MONEY-1405 residual — nothing invalidated the composition cache.** A run
 * could land a whole fresh month and `getFundComposition` would keep serving
 * the previous answer for 24h, including a `GEMINI_RECALL` over a filing that
 * had since arrived.
 *
 * ## What is asserted
 *
 * BEHAVIOUR, on the real `resolveSchemeCodes` / `resolveCandidateUrls` /
 * `invalidateCompositionCache`, driven through real `SchemeIndex` values built
 * by the real `buildSchemeIndex` from real NAVAll text. Every case below is
 * mutation-checked: scoping the master index, taking the whole family,
 * splitting `planVariant` from `navAll`, keeping the two discovery refusals
 * apart, and the cache's `written === 0` guard each have to fail a case here
 * when removed.
 *
 * Plus ONE structural property a behaviour test cannot reach: that `writeSheet`
 * routes through `resolveSchemeCodes` rather than re-deriving the decision
 * inline. A verdict function nobody calls is the defect, not the fix — the same
 * argument `mf-portfolio-verdict.test.ts` makes for `judgeAmcAttempt`.
 *
 * The source window is taken by BRACE MATCHING, never by a character count. A
 * fixed window around a branch in this very file ran past its closing brace
 * into the next block, which contained the identical string, and left the
 * assertion green.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  buildSchemeIndex,
  parseNavAllGroups,
  type AmcSource,
  type AmcHolding,
  type AmcSchemeSheet,
  type SchemeIndex,
} from "@usemoney/core/market-data";

import {
  resolveSchemeCodes,
  resolveCandidateUrls,
  invalidateCompositionCache,
  fetchNavAllViaArchive,
  schemeMatchKeyOf,
  writeSheet,
  type MasterSchemeIndex,
  type WriteContext,
  type HoldingUpsert,
} from "../../src/processors/mf-portfolio-sync";

const SRC = readFileSync(
  join(repoRoot(), "workers", "src", "processors", "mf-portfolio-sync.ts"),
  "utf8",
);

/**
 * The body of `name`'s declaration, bounded by its own braces.
 *
 * Counting characters is how a window runs into the NEXT block and matches a
 * string that is not in the block under test. This walks depth instead, so the
 * window ends exactly where the function does.
 */
function blockBody(src: string, name: string): string {
  const at = src.indexOf(name);
  assert.notEqual(at, -1, `${name} not found — retarget this scan`);
  const open = src.indexOf("{", at);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} body is unbalanced`);
}

/* ── fixtures ─────────────────────────────────────────────────────────────
   Real NAVAll text through the real parser, in AMFI's CURRENT eight-column
   grammar (`Plan;Option` between the name and the NAV, inserted 2026-08-19).
   Hand-built `SchemeIndex` objects would pin our idea of the feed instead of
   the feed.
   ──────────────────────────────────────────────────────────────────────── */

const NAVALL_HEADER =
  "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;" +
  "Scheme Name;Plan;Option;Net Asset Value;Date";

function navAll(groups: { amc: string; rows: [string, string][] }[]): string {
  const lines = [NAVALL_HEADER, ""];
  for (const g of groups) {
    lines.push(g.amc, "");
    lines.push("Open Ended Schemes(Equity Scheme - Large Cap Fund)", "");
    for (const [code, name] of g.rows) {
      lines.push(
        `${code};INF${code}A01;INF${code}A02;${name};Direct Plan;` +
          `Growth Option;101.5000;11-Sep-2026`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function indexOf(groups: { amc: string; rows: [string, string][] }[]) {
  const file = parseNavAllGroups(navAll(groups));
  assert.ok(
    file,
    "the fixture must parse — otherwise every case below is vacuous",
  );
  return buildSchemeIndex(file);
}

/** A master index shaped exactly as `buildMasterSchemeIndexOrNull` builds it. */
function masters(
  rows: { amcName: string; schemeName: string; schemeCode: string }[],
): MasterSchemeIndex {
  const byAmc = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    const key = schemeMatchKeyOf(r.schemeName);
    if (!key) continue;
    let keys = byAmc.get(r.amcName);
    if (!keys) byAmc.set(r.amcName, (keys = new Map()));
    let codes = keys.get(key);
    if (!codes) keys.set(key, (codes = new Set()));
    codes.add(r.schemeCode);
  }
  return { byAmc };
}

describe("MONEY-1401 8b — the master index is scoped by AMC", () => {
  it("a name owned by ANOTHER house yields no code, however unique it is", () => {
    // The defect, exactly. One master row industry-wide carries this name, so
    // the unscoped `codes.size === 1` test passed and handed HDFC's sheet a
    // code belonging to SBI.
    const idx = masters([
      {
        amcName: "SBI Mutual Fund",
        schemeName: "Bluechip Fund",
        schemeCode: "111111",
      },
    ]);

    const wrongHouse = resolveSchemeCodes(
      null,
      idx,
      "HDFC Mutual Fund",
      "Bluechip Fund",
    );
    assert.deepEqual(wrongHouse.codes, [], "HDFC must not receive SBI's code");
    assert.equal(wrongHouse.via, null);
    assert.equal(
      wrongHouse.ambiguous,
      false,
      "a name we never saw in this house is UNRESOLVED, not ambiguous — the " +
        "two counters mean different things and need different remediation",
    );

    // ...and the same lookup from the OWNING house still resolves, so the
    // scoping is a guard and not a blanket refusal.
    const rightHouse = resolveSchemeCodes(
      null,
      idx,
      "SBI Mutual Fund",
      "Bluechip Fund",
    );
    assert.deepEqual(rightHouse.codes, ["111111"]);
    assert.equal(rightHouse.via, "master");
  });

  it("a house absent from mutual_fund_masters ABSTAINS", () => {
    // Measured on prod 2026-09-14: all 19 registry houses ARE present, so this
    // count is zero today. It is asserted anyway because AMFI renames houses,
    // and the failure mode of a rename is this resolver silently going to zero
    // for one AMC while every other number looks normal.
    const idx = masters([
      {
        amcName: "SBI Mutual Fund",
        schemeName: "Bluechip Fund",
        schemeCode: "111111",
      },
    ]);
    const out = resolveSchemeCodes(
      null,
      idx,
      "Some New AMC Mutual Fund",
      "Bluechip Fund",
    );
    assert.deepEqual(out.codes, []);
    assert.equal(out.via, null);
  });

  it("two codes WITHIN one house is ambiguous, not a coin flip", () => {
    const idx = masters([
      { amcName: "SBI Mutual Fund", schemeName: "X Fund", schemeCode: "1" },
      // A different master name that normalises to the same match key.
      {
        amcName: "SBI Mutual Fund",
        schemeName: "X Fund (An open ended scheme)",
        schemeCode: "2",
      },
    ]);
    assert.equal(
      idx.byAmc.get("SBI Mutual Fund")?.get(schemeMatchKeyOf("X Fund"))?.size,
      2,
      "fixture must actually collide — otherwise this case proves nothing",
    );
    const out = resolveSchemeCodes(null, idx, "SBI Mutual Fund", "X Fund");
    assert.deepEqual(out.codes, []);
    assert.equal(out.via, null);
    assert.equal(out.ambiguous, true);
  });

  it("the master resolver runs only when NAVAll produced nothing", () => {
    const nav = indexOf([
      { amc: "SBI Mutual Fund", rows: [["900001", "SBI Bluechip Fund"]] },
    ]);
    const idx = masters([
      {
        amcName: "SBI Mutual Fund",
        schemeName: "SBI Bluechip Fund",
        schemeCode: "222222",
      },
    ]);
    const out = resolveSchemeCodes(
      nav,
      idx,
      "SBI Mutual Fund",
      "SBI Bluechip Fund",
    );
    assert.deepEqual(out.codes, ["900001"], "NAVAll is the FIRST resolver");
    assert.equal(out.via, "navAll");
  });
});

describe("MONEY-1294 — the whole plan family is written", () => {
  it("a 4-code family resolves, and is counted as planVariant", () => {
    // The four codes AMFI issues for one filed portfolio: Direct/Regular x
    // Growth/IDCW. The family key strips plan/option words, so all four land in
    // one family — this used to be discarded outright.
    const nav = indexOf([
      {
        amc: "SBI Mutual Fund",
        rows: [
          ["900001", "SBI Balanced Advantage Fund"],
          ["900002", "SBI Balanced Advantage Fund - Direct Plan - Growth"],
          ["900003", "SBI Balanced Advantage Fund - Regular Plan - IDCW"],
          ["900004", "SBI Balanced Advantage Fund - Direct Plan - IDCW"],
        ],
      },
    ]);
    const out = resolveSchemeCodes(
      nav,
      null,
      "SBI Mutual Fund",
      "SBI Balanced Advantage Fund",
    );
    assert.equal(
      out.codes.length,
      4,
      "all four plan codes must be carried — one filed portfolio, four codes",
    );
    assert.deepEqual([...out.codes].sort(), [
      "900001",
      "900002",
      "900003",
      "900004",
    ]);
    assert.equal(
      out.via,
      "planVariant",
      "counted APART from navAll: this is the only number that says whether " +
        "the array writer is doing anything",
    );
    assert.equal(
      out.ambiguous,
      false,
      "a plan family is RESOLVED — folding it into `ambiguous` would report " +
        "the 414 schemes this ticket fixes as refusals",
    );
  });

  it("a single-code scheme is UNCHANGED — still navAll, still one code", () => {
    const nav = indexOf([
      { amc: "SBI Mutual Fund", rows: [["900001", "SBI Solo Fund"]] },
    ]);
    const out = resolveSchemeCodes(
      nav,
      null,
      "SBI Mutual Fund",
      "SBI Solo Fund",
    );
    assert.deepEqual(out.codes, ["900001"]);
    assert.equal(out.via, "navAll");
  });

  it("the array holds every code and none of them is the sheet's own name", () => {
    // This case used to end `assert.ok(out.codes.includes(out.codes[0]!))`,
    // which is TRUE OF EVERY NON-EMPTY ARRAY — and it was titled "the primary
    // is codes[0]" while `resolveSchemeCodes` picks no primary at all. That
    // decision lives in `writeSheet` and is asserted on the UPSERT PAYLOAD in
    // the block below, where it can actually fail.
    const nav = indexOf([
      {
        amc: "SBI Mutual Fund",
        rows: [
          ["900001", "SBI Pair Fund"],
          ["900002", "SBI Pair Fund - Direct Plan"],
        ],
      },
    ]);
    const out = resolveSchemeCodes(
      nav,
      null,
      "SBI Mutual Fund",
      "SBI Pair Fund",
    );
    assert.deepEqual([...out.codes].sort(), ["900001", "900002"]);
  });

  it("writeSheet routes through resolveSchemeCodes and re-derives nothing", () => {
    // Brace-matched, not a character window.
    const body = blockBody(SRC, "async function writeSheet(");

    // THE WINDOW'S OWN CEILING, because this file has already been burned by a
    // window that ran past its closing brace into the next block, which
    // contained the identical string, and left the assertion green. A negative
    // assertion over an over-long window is not weaker — it is INVERTED.
    assert.match(
      body,
      /return written;\s*}\s*$/,
      "the writeSheet window does not end at writeSheet — every negative " +
        "assertion below is being evaluated over the wrong text",
    );
    assert.ok(
      !body.includes("function resolveCandidateUrls"),
      "the writeSheet window has run into a later declaration",
    );
    assert.match(
      body,
      /\bresolveSchemeCodes\s*\(/,
      "writeSheet must call the one decision — a pure resolver nobody calls " +
        "is the defect, not the fix",
    );
    assert.ok(
      // `\??\s*\.` because `masterIndex?.byAmc` is the SAME read and the
      // narrower pattern let a mutation through: `masterIndex` is nullable
      // here, so optional chaining is the spelling a re-introduced direct read
      // would most naturally use.
      !/\bmasterIndex\s*\??\s*\.\s*byAmc\b/.test(body),
      "writeSheet reads the master index directly again — that is the second " +
        "implementation this consolidation exists to prevent",
    );
    assert.ok(
      !/\bresolveSchemeCode\s*\(/.test(
        body.replace(/resolveSchemeCodes\s*\(/g, ""),
      ),
      "writeSheet calls the NAVAll bridge directly again",
    );
    // The `data` identifier scan that used to live here is GONE. It read
    // `assert.match(data, /\bamfiSchemeCodes\b/)`, which `amfiSchemeCodes: []`
    // satisfies — i.e. it was green against MONEY-1294's original defect
    // verbatim. The payload is asserted for real below.
  });

  it("the whole file holds no unscoped master lookup", () => {
    // `byKey` was the unscoped map's field name. Asserted over the WHOLE file
    // rather than a window: there is no second reader to miss that way.
    assert.ok(
      !/\bbyKey\b/.test(SRC),
      "the industry-wide `byKey` map is back somewhere in this file",
    );
  });
});

/* ── the row as WRITTEN ───────────────────────────────────────────────────
   MONEY-1401 review F3. Three mutations on `writeSheet`'s two identity lines
   were all GREEN against the previous suite:

     `amfiSchemeCodes[0] ?? null` -> `null`        158/158 GREEN
     `amfiSchemeCodes,`           -> `[]`          158/158 GREEN  <- MONEY-1294
     `resolution[decided.via]++`  -> `.navAll++`   158/158 GREEN

   The only guard was an identifier scan over the `data` literal, which the
   second mutation satisfies. These cases read the UPSERT ARGUMENT instead —
   the same injected-seam shape `resolveCandidateUrls` already uses, and the
   one place the three decisions are observable.
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The three fields `writeSheet` reads off a sheet, and nothing else.
 *
 * A full `AmcSchemeSheet` is fourteen fields of parse provenance (percent
 * scale, anomalies, column map) that this function never touches; building
 * them here would pin our idea of a sheet rather than the two reads under
 * test.
 */
function sheetOf(
  schemeName: string,
  instrumentNames: readonly string[],
): AmcSchemeSheet {
  const holdings: AmcHolding[] = instrumentNames.map((instrumentName, i) => ({
    instrumentName,
    // NULL ON PURPOSE: a non-null ISIN sends `writeSheet` into
    // `prisma.instrumentMapping.findFirst`, and a unit test must not open a
    // database connection to observe a payload.
    isin: null,
    industry: "Banks",
    rating: null,
    quantity: 100 + i,
    marketValueLakhs: 1000 + i,
    pctToNav: 50,
    section: "EQUITY AND EQUITY RELATED",
    amcInstrumentCode: null,
    rowIndex: i,
  }));
  return {
    sheetName: schemeName,
    schemeName,
    holdings,
  } as unknown as AmcSchemeSheet;
}

const PERIOD = new Date(Date.UTC(2026, 7, 1));

function ctxOf(
  schemeIndex: SchemeIndex | null,
  masterIndex: MasterSchemeIndex | null = null,
): WriteContext {
  return {
    period: PERIOD,
    periodLabel: "2026-08",
    schemeIndex,
    masterIndex,
    instrumentIdByIsin: new Map(),
    resolution: {
      navAll: 0,
      planVariant: 0,
      master: 0,
      ambiguous: 0,
      unresolved: 0,
    },
  };
}

/** Run `writeSheet` against a capturing upsert; return what it was handed. */
async function rowsWrittenBy(
  ctx: WriteContext,
  sheet: AmcSchemeSheet,
): Promise<{ written: number; args: Parameters<HoldingUpsert>[0][] }> {
  const args: Parameters<HoldingUpsert>[0][] = [];
  const capture: HoldingUpsert = async (a) => {
    args.push(a);
    return undefined;
  };
  const written = await writeSheet(
    "SBI",
    "SBI Mutual Fund",
    sheet,
    "https://example.invalid/aug.xlsx",
    ctx,
    capture,
  );
  return { written, args };
}

const PAIR_FAMILY = [
  {
    amc: "SBI Mutual Fund",
    rows: [
      ["900001", "SBI Pair Fund"],
      ["900002", "SBI Pair Fund - Direct Plan"],
    ] as [string, string][],
  },
];

describe("MONEY-1294 — the codes reach the ROW, not just the resolver", () => {
  it("every plan code is written, and the primary is codes[0]", async () => {
    const ctx = ctxOf(indexOf(PAIR_FAMILY));
    const { written, args } = await rowsWrittenBy(
      ctx,
      sheetOf("SBI Pair Fund", ["ICICI Bank Ltd."]),
    );

    assert.equal(written, 1, "one holding, one row");
    assert.equal(args.length, 1);
    const row = args[0]!.create as {
      amfiSchemeCode: string | null;
      amfiSchemeCodes: string[];
    };

    // MUTATION: `amfiSchemeCodes,` -> `amfiSchemeCodes: [],` -> RED.
    // This is MONEY-1294's original defect verbatim — the column was non-empty
    // on 0 of 54,248 prod rows — and the identifier scan it replaced was green
    // against exactly this.
    assert.deepEqual(
      [...row.amfiSchemeCodes].sort(),
      ["900001", "900002"],
      "the whole plan family must reach the row: four codes for one filed " +
        "portfolio is AMFI's Direct/Regular x Growth/IDCW split, not four funds",
    );

    // MUTATION: `amfiSchemeCodes[0] ?? null` -> `null` -> RED.
    assert.notEqual(
      row.amfiSchemeCode,
      null,
      "a resolved scheme must carry a primary — every reader was written " +
        "against one code",
    );
    // The primary is documented as an ARBITRARY family member, so what is
    // pinned is the RELATIONSHIP, not the value: it is codes[0], and it is one
    // of the codes. MUTATION: `amfiSchemeCodes[1] ?? null` -> RED.
    assert.equal(row.amfiSchemeCode, row.amfiSchemeCodes[0]);

    // MUTATION: `resolution[decided.via]++` -> `resolution.navAll++` -> RED.
    // `planVariant` is the ONE number that says whether the array writer is
    // doing anything; folding it into `navAll` makes a working run and a
    // MONEY-1294 run report identically.
    assert.deepEqual(ctx.resolution, {
      navAll: 0,
      planVariant: 1,
      master: 0,
      ambiguous: 0,
      unresolved: 0,
    });
  });

  it("an UNRESOLVED scheme writes null and [], and is counted as unresolved", async () => {
    // The other direction, so the case above cannot be satisfied by hardcoding
    // a code. Null in, null out — a wrong code silently attributes one fund's
    // holdings to another; a null is visibly absent.
    const ctx = ctxOf(indexOf(PAIR_FAMILY));
    const { args } = await rowsWrittenBy(
      ctx,
      sheetOf("SBI Fund Nobody Filed", ["ICICI Bank Ltd."]),
    );
    const row = args[0]!.create as {
      amfiSchemeCode: string | null;
      amfiSchemeCodes: string[];
    };
    assert.equal(row.amfiSchemeCode, null);
    assert.deepEqual(row.amfiSchemeCodes, []);
    assert.equal(ctx.resolution.unresolved, 1);
    assert.equal(ctx.resolution.planVariant, 0);
  });

  it("the key is (period, amc, schemeKey, instrumentName) and a re-run overwrites", async () => {
    // AMCs re-publish corrected disclosures and the 20th's straggler sweep
    // re-reads what the 12th already got, so both must be no-ops on unchanged
    // rows rather than duplicates.
    // MUTATION: `update: data` -> `update: {}` -> RED.
    const { args } = await rowsWrittenBy(
      ctxOf(indexOf(PAIR_FAMILY)),
      sheetOf("SBI Pair Fund", ["ICICI Bank Ltd."]),
    );
    const a = args[0]!;
    assert.deepEqual(a.where.period_amc_schemeKey_instrumentName, {
      period: PERIOD,
      amc: "SBI",
      schemeKey: (a.create as { schemeKey: string }).schemeKey,
      instrumentName: "ICICI Bank Ltd.",
    });
    assert.deepEqual(
      a.update,
      a.create,
      "a re-publish must overwrite the row, not leave a stale one",
    );
  });
});

describe("MONEY-1407 — resolveCandidateUrls keeps its two refusals apart", () => {
  const base: AmcSource = {
    id: "UTI",
    name: "UTI Mutual Fund",
    amfiMfId: "28",
    buildUrl: null,
    portalUrl: "https://example.invalid/portal",
    provenance: "observed",
    perScheme: false,
    backfillable: true,
    notes: "test fixture",
  };

  const month = new Date(Date.UTC(2026, 7, 1));

  it("DISCOVERY_FETCH_FAILED when the index does not answer", () => {
    const src: AmcSource = {
      ...base,
      discoverUrl: {
        apiUrl: () => "https://example.invalid/api",
        pick: () => "https://example.invalid/file.zip",
      },
    };
    return resolveCandidateUrls(src, month, async () => null).then((out) => {
      assert.deepEqual(out.urls, []);
      assert.equal(
        out.refusal,
        "DISCOVERY_FETCH_FAILED",
        "a dead site and an unpublished month must not be the same log line",
      );
    });
  });

  it("NO_PICK when the index answers and names nothing", async () => {
    const src: AmcSource = {
      ...base,
      discoverUrl: {
        apiUrl: () => "https://example.invalid/api",
        pick: () => null,
      },
    };
    const out = await resolveCandidateUrls(
      src,
      month,
      async () => '{"rows":[]}',
    );
    assert.deepEqual(out.urls, []);
    assert.equal(out.refusal, "NO_PICK");
  });

  it("NO_PICK when the index answers 200 with something that is not JSON", async () => {
    const src: AmcSource = {
      ...base,
      discoverUrl: {
        apiUrl: () => "https://example.invalid/api",
        pick: () => {
          throw new Error("pick must not run on an unparseable body");
        },
      },
    };
    const out = await resolveCandidateUrls(
      src,
      month,
      async () => "<html>throttled</html>",
    );
    assert.deepEqual(out.urls, []);
    assert.equal(out.refusal, "NO_PICK");
  });

  it("a pick returns the vendor's URL VERBATIM, and issues one request", async () => {
    let calls = 0;
    const src: AmcSource = {
      ...base,
      discoverUrl: {
        apiUrl: (m) =>
          `https://example.invalid/api?month=${m.getUTCMonth() + 1}`,
        pick: (body) =>
          (body as { rows: { url: string }[] }).rows[0]?.url ?? null,
      },
    };
    const out = await resolveCandidateUrls(src, month, async (url) => {
      calls++;
      assert.equal(url, "https://example.invalid/api?month=8");
      return '{"rows":[{"url":"https://cdn.invalid/x.zip?VersionId=abc"}]}';
    });
    assert.deepEqual(out.urls, ["https://cdn.invalid/x.zip?VersionId=abc"]);
    assert.equal(out.refusal, null);
    assert.equal(calls, 1);
  });

  it("a templatable house needs NO request at all", async () => {
    const src: AmcSource = {
      ...base,
      id: "SBI",
      name: "SBI Mutual Fund",
      buildUrl: () => "https://example.invalid/aug.xlsx",
      altUrls: () => ["https://example.invalid/august.xlsx"],
    };
    const out = await resolveCandidateUrls(src, month, async () => {
      throw new Error("a buildUrl house must not fetch to find its own URL");
    });
    assert.deepEqual(out.urls, [
      "https://example.invalid/aug.xlsx",
      "https://example.invalid/august.xlsx",
    ]);
    assert.equal(out.refusal, null);
  });

  it("NO_PICK when a house has neither a template nor a discovery index", async () => {
    const out = await resolveCandidateUrls(base, month, async () => {
      throw new Error("must not fetch");
    });
    assert.deepEqual(out.urls, []);
    assert.equal(out.refusal, "NO_PICK");
  });
});

describe("MONEY-1401 — NAVAll rides the SAME archive key as packages/core", () => {
  // The URL itself is already pinned in `amfi-mf-provider.test.ts`
  // (`AMFI_NAV_URL === AMFI_NAVALL_URL`). What that test cannot see is the
  // DESCRIPTOR, which is what `buildFeedArchiveKey` turns into the object path.
  // `fetchNavAllText` is not exported from packages/core, so this file states
  // its own descriptor — and two copies of one key drift SILENTLY: prod would
  // write a second object and QA would miss and re-scrape, i.e. exactly the
  // behaviour this change removed, with nothing failing.
  const PROVIDER = readFileSync(
    join(
      repoRoot(),
      "packages",
      "core",
      "src",
      "market-data",
      "instruments",
      "amfi-mf-provider.ts",
    ),
    "utf8",
  );

  it("both callers spell one descriptor", () => {
    for (const line of [
      'exchange: "AMFI",',
      'feed: "navall",',
      "date: day,",
      "basename: `NAVAll-${toIstDateKey(day)}.txt`,",
    ]) {
      assert.ok(
        SRC.includes(line),
        `the worker no longer writes ${JSON.stringify(line)}`,
      );
      assert.ok(
        PROVIDER.includes(line),
        `amfi-mf-provider no longer writes ${JSON.stringify(line)} — the two ` +
          `NAVAll readers have drifted apart and now archive to two keys`,
      );
    }
  });

  it("both callers send the same referer", () => {
    const worker = /AMFI_NAVALL_REFERER = "([^"]+)"/.exec(SRC);
    const provider = /AMFI_NAV_REFERER = "([^"]+)"/.exec(PROVIDER);
    assert.ok(worker, "AMFI_NAVALL_REFERER not found — retarget this scan");
    assert.ok(provider, "AMFI_NAV_REFERER not found — retarget this scan");
    assert.equal(worker[1], provider[1]);
  });

  it("buildSchemeIndexOrNull reads the feed through the seam, not a raw fetch", () => {
    // `no-feed-fetch-bypass.test.ts` polices the whole tree; this pins the ONE
    // call, so a revert here fails in the file it happened in.
    const body = blockBody(SRC, "async function buildSchemeIndexOrNull(");
    assert.match(body, /\bfetchNavAllViaArchive\s*\(/);
    assert.ok(
      !/\bfetchText\s*\(/.test(body),
      "buildSchemeIndexOrNull is back on the un-archived fetch",
    );

    // The injected fetcher's DEFAULT is the archive seam — asserted on the
    // signature, because the body only ever names the parameter. Production
    // passes no argument, so the default IS the production path.
    assert.match(
      SRC,
      /get:\s*typeof\s+getFeedAsset\s*=\s*getFeedAsset/,
      "fetchNavAllViaArchive's default fetcher is no longer getFeedAsset — " +
        "the injected seam would then be testable and the live path un-seamed",
    );
    const seam = blockBody(SRC, "export async function fetchNavAllViaArchive(");
    assert.ok(
      !/\bfetch\s*\(/.test(seam),
      "fetchNavAllViaArchive makes a raw call beside the seam — the seam has " +
        "to be the ONLY path or the un-archived one is still live",
    );
  });

  it("a 404 is null, not an exception", async () => {
    // `getFeedAsset` maps 404 -> null. AMFI publishes NAVAll every calendar
    // day, so this is a broken fetch — but it degrades the ENRICHMENT, it does
    // not lose the month's holdings.
    assert.equal(await fetchNavAllViaArchive(async () => null), null);
  });

  it("a thrown non-404 status is caught, not propagated", async () => {
    // The property a `catch` source-scan could NOT establish: a rethrowing
    // catch satisfies `/catch\b/` and this assertion kills it. Every other
    // non-OK status throws out of `getFeedAsset`, and letting it escape turns a
    // NAV outage into a lost month of holdings.
    assert.equal(
      await fetchNavAllViaArchive(async () => {
        throw new Error("503 from AMFI");
      }),
      null,
    );
  });

  it("bytes come back as text", async () => {
    const got = await fetchNavAllViaArchive(
      async () => new Response("Scheme Code;…"),
    );
    assert.equal(got, "Scheme Code;…");
  });

  it("the descriptor it passes is the dated, explicitly-named one", async () => {
    // Observed, not read off the source. `basename` matters most: the URL's own
    // basename is the constant `NAVAll.txt`, so a dated descriptor without one
    // collapses a whole month onto a single object.
    let seen: unknown;
    await fetchNavAllViaArchive(async (_url, _ref, descriptor) => {
      seen = descriptor;
      return new Response("x");
    });
    const d = seen as {
      exchange: string;
      feed: string;
      date?: Date;
      basename?: string;
    };
    assert.equal(d.exchange, "AMFI");
    assert.equal(d.feed, "navall");
    assert.ok(d.date instanceof Date, "the descriptor must be DATED");
    assert.match(
      d.basename ?? "",
      /^NAVAll-\d{4}-\d{2}-\d{2}\.txt$/,
      "an undated basename collapses a month of fetches onto one key",
    );
  });
});

describe("MONEY-1405 residual — the composition cache is invalidated", () => {
  it("a run that wrote nothing clears nothing", async () => {
    let called = 0;
    await invalidateCompositionCache(0, async () => {
      called++;
      return 0;
    });
    assert.equal(called, 0, "no row changed, so nothing is stale");
  });

  it("a run that wrote clears the whole fund-composition namespace", async () => {
    const patterns: string[] = [];
    await invalidateCompositionCache(1, async (p) => {
      patterns.push(p);
      return 7;
    });
    assert.deepEqual(patterns, ["fund-composition:_global:*"]);
    // Both `source` variants and all three fund types have to go. A pattern
    // naming one of them leaves a GEMINI_RECALL standing over a real filing.
    for (const key of [
      "fund-composition:_global:MF%3A119598%3A119598%3AAMC_DISCLOSURE:default",
      "fund-composition:_global:MF%3A119598%3A119598%3AGEMINI_RECALL:default",
      "fund-composition:_global:ETF%3ANIFTYBEES%3A120716%3AAMC_DISCLOSURE:default",
    ]) {
      assert.ok(
        matchesGlob(patterns[0]!, key),
        `${patterns[0]} does not cover ${key}`,
      );
    }
  });

  it("a cache outage does not fail a run whose holdings are committed", async () => {
    await invalidateCompositionCache(1, async () => {
      throw new Error("redis down");
    });
  });
});

/** Redis-style glob: `*` matches any run of characters. */
function matchesGlob(pattern: string, key: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`))}$`,
  );
  return re.test(key);
}
