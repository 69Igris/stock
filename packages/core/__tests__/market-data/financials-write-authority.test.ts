/**
 * Every writer of `StockFinancials` / `StockRatios` consults the declared
 * authority order — MONEY-1204.
 *
 * ## Why this is a DISCOVERY scan and not a list
 *
 * MONEY-1198 fixed the two `stockFinancials.upsert` calls in
 * `financial-data-sync.ts` and pinned them with a structural test that read
 * exactly two files by name. Six months of that test being green proved
 * nothing about the other FOUR unguarded writers that existed the whole time —
 * `financial-data-sync.ts`'s own `stockRatios.upsert` (the highest-frequency
 * one of the set: `ratios-sync-daily`, 23:30 IST Mon-Fri), and three in
 * `packages/research`. A test that enumerates its subjects can only ever
 * confirm what its author already knew.
 *
 * So this walks the source tree, finds write calls against those two models by
 * pattern, and requires each one to carry a guard. Adding an unguarded writer
 * anywhere under `apps/`, `packages/`, `workers/` or `scripts/` turns it red
 * without anyone remembering to update a list. That is its entire purpose; the
 * behavioural half below is just enough to prove the guard it demands is worth
 * demanding.
 *
 * Same shape and the same reasoning as
 * `packages/core/__tests__/market-data/sector-write-guard.test.ts`, which learned
 * it the same way (three enumerating attempts, each defeated by the writer it
 * did not know about).
 *
 * ## Why the stakes are asymmetric here
 *
 * NEITHER model has `source` in its unique key. `StockFinancials` is
 * `@@unique([symbol, exchange, statementType, periodType, period])` and
 * `StockRatios` is `@@unique([symbol, exchange])` — one row per symbol, no
 * period dimension at all. Two sources describing the same thing are ONE row, so
 * an unguarded write is not a duplicate to be reconciled later: the other
 * source's value is simply gone. Worse, these `update:` clauses rewrite values
 * without touching `source`, so the row goes on asserting a provenance it no
 * longer has — the exact state MONEY-1175 sat in for months, undetected, because
 * nothing errors and no count looks wrong.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  chooseAuthority,
  mayOverwriteFinancials,
  FINANCIALS_AUTHORITY,
} from "../../src/market-data/xbrl-projection";

/** Resolved from THIS FILE, not cwd — a cwd-relative path throws inside the
 *  describe body, which node reports as a dropped suite (`fail 0`, exit 0). */
const REPO = join(import.meta.dirname, "..", "..", "..", "..");

// ── The helper's behaviour ───────────────────────────────────────────────

describe("mayOverwriteFinancials", () => {
  it("permits a write when the row is ABSENT", () => {
    // Filling an empty cell is not a conflict. Both spellings of absent, because
    // a `findUnique` returns null while `incumbent?.source` on a missing row
    // yields undefined — the guards call it the second way.
    assert.equal(mayOverwriteFinancials("TICKERTAPE", null), true);
    assert.equal(mayOverwriteFinancials("TICKERTAPE", undefined), true);
    assert.equal(mayOverwriteFinancials("YAHOO", null), true);
  });

  it("permits a source to REFRESH its own row", () => {
    // Equal rank is a correction, not a displacement. Forbidding it would stop
    // the nightly job doing its actual job — a guard so broad it breaks the
    // happy path gets reverted, which is worse than no guard.
    for (const s of FINANCIALS_AUTHORITY) {
      assert.equal(mayOverwriteFinancials(s, s), true, s);
    }
  });

  it("permits a HIGHER-ranked challenger", () => {
    assert.equal(mayOverwriteFinancials("NSE_XBRL", "TICKERTAPE"), true);
    assert.equal(mayOverwriteFinancials("TICKERTAPE", "SCREENER"), true);
    assert.equal(mayOverwriteFinancials("SCREENER", "YAHOO"), true);
  });

  it("REFUSES a lower-ranked challenger — the whole point", () => {
    assert.equal(mayOverwriteFinancials("TICKERTAPE", "NSE_XBRL"), false);
    assert.equal(mayOverwriteFinancials("SCREENER", "NSE_XBRL"), false);
    assert.equal(mayOverwriteFinancials("YAHOO", "TICKERTAPE"), false);
  });

  it("lets an UNKNOWN incumbent be overwritten, and an unknown challenger only fill a gap", () => {
    // An unknown source ranks LAST rather than being rejected, so a new upstream
    // appearing cannot crash a write path and cannot displace anything known.
    assert.equal(mayOverwriteFinancials("TICKERTAPE", "MORNINGSTAR"), true);
    assert.equal(mayOverwriteFinancials("MORNINGSTAR", "TICKERTAPE"), false);
    assert.equal(mayOverwriteFinancials("MORNINGSTAR", null), true);
    // Two unknowns tie, and a tie is a refresh.
    assert.equal(mayOverwriteFinancials("MORNINGSTAR", "MORNINGSTAR"), true);
  });

  it("is exactly the negation of chooseAuthority().keepIncumbent, for every pair", () => {
    // The reason this helper exists is that four call sites were about to
    // derive this themselves. If the two ever disagreed, the guards and the
    // projection writer would be enforcing different orders — the failure that
    // looks like nothing at all.
    const universe = [...FINANCIALS_AUTHORITY, "MORNINGSTAR"];
    for (const c of universe) {
      for (const i of universe) {
        assert.equal(
          mayOverwriteFinancials(c, i),
          !chooseAuthority(c, i).keepIncumbent,
          `${c} over ${i}`,
        );
      }
      assert.equal(
        mayOverwriteFinancials(c, null),
        !chooseAuthority(c, null).keepIncumbent,
        `${c} over <absent>`,
      );
    }
  });

  it("is pure — no I/O, and the same answer every time", () => {
    // Stated as a test because the guards call it inside a loop over every
    // period of every symbol. A helper that reached for Prisma here would turn
    // one query per row into two.
    const a = mayOverwriteFinancials("TICKERTAPE", "NSE_XBRL");
    const b = mayOverwriteFinancials("TICKERTAPE", "NSE_XBRL");
    assert.equal(a, b);
    assert.equal(a, false);
  });
});

// ── The discovery scan ───────────────────────────────────────────────────

/**
 * Roots walked. `scripts/` is INCLUDED here — unlike `sector-write-guard.test.ts`,
 * which excludes it — because the exemptions below are per-file with an expected
 * site count, so an operator-invoked script that gains a NEW write still has to
 * be justified rather than inheriting a blanket pass for its directory.
 */
const ROOTS = ["apps", "packages", "workers", "scripts"];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "__tests__",
  "coverage",
  ".turbo",
  ".git",
  "build",
  "generated",
]);

/**
 * Write sites that legitimately have no `mayOverwriteFinancials` call, each with
 * the reason and the number of sites the exemption covers.
 *
 * The COUNT is load-bearing. Keying an exemption on the file alone would mean a
 * new, genuinely unguarded write added to an already-exempt file inherits the
 * pass silently — which is the same "the list did not know about it" failure
 * this whole scan exists to end. Change a file's site count and this test makes
 * you say why.
 */
const AUTHORITY_EXEMPTIONS: ReadonlyArray<{
  file: string;
  sites: number;
  reason: string;
}> = [
  {
    file: "workers/src/processors/xbrl-projection-writer.ts",
    sites: 2,
    reason:
      "IT IS the top-authority writer, and it consults the order through the " +
      "RICHER form: `planFinancialsWrite` calls `chooseAuthority` internally and " +
      "returns action SKIP/skipReason AUTHORITY, which the caller counts as " +
      "`out.skippedAuthority`. It needs the loser's identity as well as the " +
      "boolean, so it can preserve the displaced row in `rawData.displacedByXbrl` " +
      "— `mayOverwriteFinancials` throws that away by design. Both its write " +
      "sites (create + update) sit behind `if (!args.apply) return;`, and `apply` " +
      "defaults to FALSE.",
  },
  {
    file: "workers/src/processors/document-financials-projection-logic.ts",
    sites: 2,
    reason:
      "MONEY-1255, and the SAME carve-out as xbrl-projection-writer.ts above: " +
      "it consults the order through the RICHER form. `planDocumentFinancialsWrite` " +
      "(packages/core/src/market-data/document-financials-projection.ts) imports " +
      "`chooseAuthority` and `FINANCIALS_AUTHORITY` from the shared module and " +
      "never re-derives either, returning action SKIP with skipReason AUTHORITY; " +
      'the caller returns at `plan.action === "SKIP"` BEFORE reaching either ' +
      "write site. It needs the loser's identity as well as the boolean so it can " +
      "preserve the displaced row — `mayOverwriteFinancials` discards that by " +
      "design. VERIFIED by reading the call chain rather than taking the writer's " +
      "word for it: an exemption granted on an unverified claim is precisely the " +
      "unguarded writer this file exists to catch. Both writes additionally sit " +
      'behind DOC_FINANCIALS_APPLY, which ships PRESENT and "false".',
  },
  {
    file: "scripts/ops/repair-stock-ratios-links.ts",
    sites: 1,
    reason:
      "Writes ONLY the `instrumentId` FK — it repairs a dangling relation after " +
      "an InstrumentMapping re-seed and touches no source-bearing value and not " +
      "`source` itself. Structurally the same carve-out as `sector: null` in " +
      "sector-write-guard.test.ts: a write that cannot displace another source's " +
      "numbers needs no authority check. Operator-invoked, not scheduled.",
  },
  {
    file: "scripts/seed/seed-stock-financials.ts",
    sites: 1,
    reason:
      "Seed. Runs against a fresh/empty collection by construction, so there is " +
      "no incumbent to outrank; and it is operator-invoked with a human reading " +
      "the output, not a nightly job reverting rows unattended.",
  },
  {
    file: "scripts/seed/seed-stock-ratios.ts",
    sites: 1,
    reason:
      "Seed. Same reasoning as seed-stock-financials.ts: it populates an " +
      "environment that has no incumbent rows yet, and a human is watching it " +
      "run. It is not scheduled and cannot revert anything unattended.",
  },
  {
    file: "scripts/seed/seed-etf-data.ts",
    sites: 1,
    reason:
      "Seed — same reasoning. Writes ETF ratio rows into an environment being " +
      "populated, where no higher-authority source has written anything yet.",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e)) out.push(full);
  }
  return out;
}

/** Strip comments so prose describing a write cannot be mistaken for one, and a
 *  commented-out guard cannot make a real write look guarded. The `[^:]` before
 *  `//` keeps `https://` in a string from eating the rest of its line. */
function stripComments(s: string): string {
  return s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Any receiver, not just `prisma.` — the projection writer takes its client as
 * an argument and calls `db.stockFinancials.create(...)`, and a `$transaction`
 * callback would call `tx.…`. Binding the pattern to the identifier `prisma`
 * would have missed both.
 */
const WRITE_CALL =
  /\.\s*(stockFinancials|stockRatios)\s*\.\s*(upsert|update|updateMany|create|createMany)\s*\(/g;

/**
 * A guard is a call to the shared helper, or to a local wrapper whose name ends
 * in `MayWrite` — `financial-data-sync.ts` uses two (`tickertapeMayWrite`,
 * `tickertapeRatiosMayWrite`) because each has to build a different unique key
 * before asking. The wrapper form is only accepted because the import assertion
 * below independently forces every such file to pull in
 * `mayOverwriteFinancials`, so a wrapper cannot invent its own ordering.
 */
const GUARD_CALL = /(mayOverwriteFinancials|[A-Za-z_$][\w$]*MayWrite)\s*\(/g;

/** How far before the write a guard may sit and still be guarding it. A guard
 *  elsewhere in the file protects nothing. */
const GUARD_WINDOW = 400;

interface WriteSite {
  file: string;
  model: string;
  verb: string;
  /** 1-indexed line in the STRIPPED source — enough to tell two sites in one
   *  file apart, which is all it is for. */
  line: number;
  guarded: boolean;
  /** Source of the file, kept so the import assertion does not re-read it. */
  src: string;
}

function findWriteSites(): WriteSite[] {
  const found: WriteSite[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root))) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!src.includes("stockFinancials") && !src.includes("stockRatios")) {
        continue;
      }
      const stripped = stripComments(src);
      WRITE_CALL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WRITE_CALL.exec(stripped)) !== null) {
        const window = stripped.slice(
          Math.max(0, m.index - GUARD_WINDOW),
          m.index,
        );
        GUARD_CALL.lastIndex = 0;
        found.push({
          file: file.replace(`${REPO}/`, ""),
          model: m[1]!,
          verb: m[2]!,
          line: stripped.slice(0, m.index).split("\n").length,
          guarded: GUARD_CALL.test(window),
          src,
        });
      }
    }
  }
  return found;
}

const SITES = findWriteSites();
const EXEMPT_FILES = new Set(AUTHORITY_EXEMPTIONS.map((e) => e.file));

describe("every StockFinancials / StockRatios writer honours FINANCIALS_AUTHORITY", () => {
  it("the scan finds writers at all — it must not pass vacuously", () => {
    // Liveness. If the walk breaks or the pattern stops matching, an empty
    // result makes every assertion below trivially true, and the suite goes on
    // reporting green while protecting nothing.
    //
    // The floor moved 10 -> 8 in MONEY-1220, and the direction is the point: two
    // write sites were DELETED (`db-store.ts`'s `stockRatios` upsert and
    // `stockPeers` upsert — request-time writes on a read path, from a source
    // that 403s our egress). A floor is a liveness check on the SCAN, not a
    // target for the codebase, so it is set below the true count with slack:
    // a broken walk returns 0 or 1, which still fails, while one legitimate
    // removal no longer turns this red for the wrong reason. Raise it again if
    // the population grows — never lower it to accommodate a removal you have
    // not looked at.
    assert.ok(
      SITES.length >= 8,
      `expected at least 8 write sites across ${ROOTS.join(", ")}, found ` +
        `${SITES.length}: ${SITES.map((s) => `${s.file}:${s.line}`).join(", ")}`,
    );
  });

  it("reaches the writers it was built to reach", () => {
    // Pins the scan's REACH, not just its count. These are the paths that were
    // unguarded; if a refactor moves one somewhere the walk cannot see, this
    // fails loudly instead of silently shrinking coverage.
    //
    // MONEY-1220 replaced one of the four. `financial-data-sync.ts` is DELETED
    // — Tickertape 403s our egress, so its statements and ratios legs moved to
    // `xbrl-projection-writer.ts` and `xbrl-ratios.ts`, which read our own
    // archived NSE filings. The canary follows the writers rather than the
    // filenames: dropping the row would have quietly shrunk the reach this test
    // exists to pin, which is the failure mode it is guarding against.
    const byFile = new Map<string, number>();
    for (const s of SITES) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
    for (const [file, min] of [
      ["workers/src/processors/xbrl-projection-writer.ts", 1],
      ["workers/src/processors/xbrl-ratios.ts", 1],
      ["packages/research/src/data-sources/persistence.ts", 1],
    ] as const) {
      assert.ok(
        (byFile.get(file) ?? 0) >= min,
        `${file} should hold at least ${min} write site(s); the scan found ` +
          `${byFile.get(file) ?? 0}. The walk or the call pattern has regressed. ` +
          `Files seen: ${[...byFile.keys()].join(", ")}`,
      );
    }
  });

  it("db-store.ts holds NO write sites — it is a read module now", () => {
    // The inverse of the reach list above, and deliberately not folded into it:
    // "at least 1" and "exactly 0" are opposite claims, and the second is the
    // one worth pinning here.
    //
    // Three write sites lived in this file and all three are gone (MONEY-1220):
    // `getOrFetchFinancials` persisted a Tickertape fetch, `getOrFetchRatios`
    // upserted a whole StockRatios row, `getOrFetchPeers` upserted StockPeers.
    // A READ PATH MUST NOT WRITE these tables. `StockFinancials` has no `source`
    // in its unique key, so a request-time write from the weakest source can
    // occupy a period the nightly projection then has to displace; `StockRatios`
    // is @@unique([symbol, exchange]) — one row, no period — so a single
    // request-time upsert replaces a symbol's ENTIRE ratio set.
    //
    // If a write comes back here, it needs a guard AND a reason, and this test
    // is where that argument gets made.
    const byFile = new Map<string, number>();
    for (const s of SITES) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
    assert.equal(
      byFile.get("packages/research/src/data-sources/db-store.ts") ?? 0,
      0,
      "db-store.ts writes StockFinancials/StockRatios again on a read path",
    );
  });
  it("covers both models — a scan that only sees financials misses the daily job", () => {
    // `stockRatios` was the site that stayed unguarded through MONEY-1198, and
    // it is the one that runs every weeknight. A pattern regression that quietly
    // dropped one model would restore exactly that blind spot.
    assert.ok(SITES.some((s) => s.model === "stockFinancials"));
    assert.ok(SITES.some((s) => s.model === "stockRatios"));
  });

  for (const site of SITES) {
    if (EXEMPT_FILES.has(site.file)) continue;
    it(`${site.file}:${site.line} guards ${site.model}.${site.verb} with an authority check`, () => {
      assert.ok(
        site.guarded,
        `${site.file}:${site.line} writes ${site.model} with no ` +
          `mayOverwriteFinancials(...) (or *MayWrite(...)) call within ` +
          `${GUARD_WINDOW} characters before it.\n\n` +
          `Neither model has \`source\` in its unique key, so this write ` +
          `REPLACES whatever another source put there — and its \`update:\` ` +
          `clause leaves \`source\` alone, so the row keeps claiming a ` +
          `provenance it no longer has.\n\n` +
          `Read the incumbent's source with a findUnique on the model's own ` +
          `unique key and skip when ` +
          `\`mayOverwriteFinancials(<thisWriter'sSource>, incumbent?.source)\` ` +
          `is false. If this write genuinely cannot displace another source, ` +
          `add it to AUTHORITY_EXEMPTIONS with a written reason.`,
      );
    });
  }

  for (const site of SITES) {
    if (EXEMPT_FILES.has(site.file)) continue;
    it(`${site.file} imports the shared helper rather than re-deriving the order`, () => {
      // The scan above accepts a local `*MayWrite` wrapper, which on its own
      // would let a file hand-roll `source !== "NSE_XBRL"` behind a
      // guard-shaped name. This closes that: the ORDER may only come from
      // @usemoney/core/market-data, so adding a source stays a one-file edit.
      const imports = [
        ...site.src.matchAll(
          /import\s*(?:type\s*)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g,
        ),
      ];
      const ok = imports.some(
        (m) =>
          /\bmayOverwriteFinancials\b/.test(m[1]!) && /market-data/.test(m[2]!),
      );
      assert.ok(
        ok,
        `${site.file} writes ${site.model} but does not import ` +
          `mayOverwriteFinancials from @usemoney/core/market-data. A guard that ` +
          `re-derives the ordering locally is a second copy of ` +
          `FINANCIALS_AUTHORITY, and the copy nobody updates is the one that ` +
          `silently keeps letting a lower-ranked source win.`,
      );
    });
  }
});

describe("the exemption table stays honest", () => {
  it("every exemption still matches a real file with write sites", () => {
    // A DEAD exemption is not harmless: it is a standing pass for a path that no
    // longer needs one, ready to cover a future unguarded writer added to the
    // same file.
    for (const ex of AUTHORITY_EXEMPTIONS) {
      const hits = SITES.filter((s) => s.file === ex.file);
      assert.ok(
        hits.length > 0,
        `AUTHORITY_EXEMPTIONS lists ${ex.file}, but the scan found no write ` +
          `sites there. Remove the exemption.`,
      );
    }
  });

  it("every exemption covers exactly the number of sites it claims", () => {
    // The forcing function: a NEW write added to an exempt file changes the
    // count and has to be justified, instead of inheriting the pass.
    for (const ex of AUTHORITY_EXEMPTIONS) {
      const hits = SITES.filter((s) => s.file === ex.file);
      assert.equal(
        hits.length,
        ex.sites,
        `${ex.file} is exempt for ${ex.sites} write site(s) but now has ` +
          `${hits.length} (${hits.map((h) => `${h.model}.${h.verb}@${h.line}`).join(", ")}). ` +
          `Re-justify each one before changing the count.`,
      );
    }
  });

  it("every exemption carries a written reason", () => {
    for (const ex of AUTHORITY_EXEMPTIONS) {
      assert.ok(
        ex.reason.trim().length >= 60,
        `${ex.file} is exempt without a reason worth reading`,
      );
    }
  });

  it("the projection writer is exempt because it uses the RICHER form, not because it skips the check", () => {
    // Guards the one exemption that could hide a real regression. If
    // `planFinancialsWrite` were ever removed from that file, the exemption
    // would still be listed and the writer would be unguarded — this is what
    // notices.
    const src = readFileSync(
      join(REPO, "workers/src/processors/xbrl-projection-writer.ts"),
      "utf8",
    );
    assert.match(src, /planFinancialsWrite\s*\(/);
    assert.match(src, /skipReason\s*===\s*"UNCHANGED"/);
    assert.match(src, /skippedAuthority/);
  });
});
