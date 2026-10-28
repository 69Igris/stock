/**
 * TWO XBRL WRITE ARMS, ONE PER JOB — MONEY-1286.
 *
 * ## The state that could not be expressed
 *
 * `xbrl-projection` (writes `stock_financials`) and `xbrl-ratios` (writes
 * `stock_ratios`) both read `XBRL_PROJECTION_APPLY`, so ONE environment
 * variable armed TWO irreversible writes into TWO different tables. Then both
 * gates were run against prod on 2026-08-30 and they DISAGREED:
 *
 *   `xbrlratios prod`   PASS       `roe` READY at 666/697 (95.6%), none BLOCKED
 *   `xbrlrecon  prod`   NOT READY  `totalLiabilities` disagrees on 17.2% of
 *                                  pairs, `totalAssets`/`totalEquity` 6.9%,
 *                                  `netIncome` 5.9%, against a 5.0% floor
 *
 * The state the evidence supports — ratios ON, financials OFF — was
 * inexpressible: arming what passed would have armed what failed. Both writes
 * are one-way doors (neither table carries `source` in its unique key, so the
 * first XBRL write destroys the vendor value its gate still needs), so "arm
 * both and watch" is not available either.
 *
 * ## What these tests are for
 *
 * The split is only worth anything if it is REAL. Two ways it silently reverts:
 *
 *   1. The processor goes back to reading `XBRL_PROJECTION_APPLY` — every
 *      existing test stays green, because every existing test that arms this
 *      job arms it through whichever variable the code happens to read.
 *   2. The new flag never reaches the deployed spec, so prod runs with it
 *      ABSENT. Absent and explicitly-`"false"` behave identically and read
 *      completely differently: "absent" is exactly how `MF_METADATA_PROVIDER`
 *      disabled its job silently for months (MONEY-1214).
 *
 * The first is covered BEHAVIOURALLY — the real `processXbrlRatios` runs
 * against an in-memory store and its upserts are counted — because a source
 * assertion cannot tell a flag that is READ from a flag that is merely
 * mentioned. The second is covered as a deploy contract over both cloudbuild
 * specs, modelled on `services/us-fundamentals/tests/test_deploy_contract.py`'s
 * `INTENDED_FLAG_STATE`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  processXbrlRatios,
  isRatiosArmed,
  isDocRatiosArmed,
  resolveRatiosApply,
  resolveDocRatiosApply,
} from "../../src/processors/xbrl-ratios";
import {
  isProjectionArmed,
  resolveApply,
} from "../../src/processors/xbrl-projection";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const CB_PROD = read("workers/cloudbuild.prod.yaml");
const CB_QA = read("workers/cloudbuild.qa.yaml");

/* -------------------------------------------------------------------------- */
/* The two arms, decided independently                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every combination, stated rather than sampled. The two interesting cells are
 * the MIXED ones: they are the whole reason this ticket exists, and they are
 * the two a shared flag could not produce.
 */
const MATRIX: ReadonlyArray<{
  ratiosEnv: string | undefined;
  projectionEnv: string | undefined;
  ratios: boolean;
  projection: boolean;
  why: string;
}> = [
  {
    ratiosEnv: "true",
    projectionEnv: "false",
    ratios: true,
    projection: false,
    why: "THE SHIPPING TARGET: the ratios gate passed, the reconcile did not",
  },
  {
    ratiosEnv: "false",
    projectionEnv: "true",
    ratios: false,
    projection: true,
    why: "the inverse — neither flag may leak into the other's job",
  },
  {
    ratiosEnv: "true",
    projectionEnv: "true",
    ratios: true,
    projection: true,
    why: "both armed",
  },
  {
    ratiosEnv: "false",
    projectionEnv: "false",
    ratios: false,
    projection: false,
    why: "today's shipped posture in both environments",
  },
  {
    ratiosEnv: undefined,
    projectionEnv: undefined,
    ratios: false,
    projection: false,
    why: "absent is off — a new environment must opt IN to a one-way door",
  },
  {
    ratiosEnv: "TRUE",
    projectionEnv: "True",
    ratios: false,
    projection: false,
    why: "the comparison is to the exact literal, not a case-folded one",
  },
  {
    ratiosEnv: "1",
    projectionEnv: "yes",
    ratios: false,
    projection: false,
    why: "truthy-but-not-'true' must not arm; only the literal does",
  },
];

describe("the two XBRL arms are decided independently — MONEY-1286", () => {
  for (const cell of MATRIX) {
    it(`ratios=${String(cell.ratiosEnv)} projection=${String(
      cell.projectionEnv,
    )} — ${cell.why}`, () => {
      const env: NodeJS.ProcessEnv = {};
      if (cell.ratiosEnv !== undefined) env.XBRL_RATIOS_APPLY = cell.ratiosEnv;
      if (cell.projectionEnv !== undefined) {
        env.XBRL_PROJECTION_APPLY = cell.projectionEnv;
      }
      assert.equal(
        isRatiosArmed(env),
        cell.ratios,
        "the ratios job read the wrong variable",
      );
      assert.equal(
        isProjectionArmed(env),
        cell.projection,
        "the projection job read the wrong variable",
      );
      // The message seam narrows and can never arm — asserted on BOTH jobs,
      // because that property is what makes an env-only arm meaningful.
      assert.equal(resolveRatiosApply(undefined, env), cell.ratios);
      assert.equal(resolveApply(undefined, env), cell.projection);
      assert.equal(
        resolveRatiosApply({ apply: false }, env),
        false,
        "`apply:false` must narrow the ratios job",
      );
      assert.equal(
        resolveApply({ apply: false }, env),
        false,
        "`apply:false` must narrow the projection job",
      );
      assert.equal(
        resolveRatiosApply({ apply: true }, env),
        cell.ratios,
        "a message must never ARM the ratios job",
      );
    });
  }

  it("`Boolean()` would invert the shipped posture, which is why it is banned", () => {
    // Stated as arithmetic rather than as a comment: `Boolean("false")` is
    // true, so a truthiness check arms the job in exactly the configuration
    // that ships today (MONEY-1214).
    assert.equal(Boolean("false"), true);
    assert.equal(isRatiosArmed({ XBRL_RATIOS_APPLY: "false" }), false);
  });
});

/* -------------------------------------------------------------------------- */
/* BEHAVIOURAL: the real processor, the real writes                            */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

const NOW = new Date("2026-08-21T00:00:00.000Z");
const day = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

/**
 * One filing rich enough to clear `isPlanWorthWriting` — revenue + profit give
 * `netMargin`, and the two balance-sheet lines give `roe` and `roa`, which is
 * the three-filing-field floor. Deliberately the same shape the rotation test
 * uses, so an armed run here really does reach the upsert.
 */
function filing(): Row {
  const periodEnd = new Date("2025-03-31T00:00:00.000Z");
  const revenue = 1_000_000_000;
  return {
    id: "f-1",
    instrumentId: "i-a",
    periodEnd,
    periodType: "ANNUAL",
    cumulative: false,
    basis: "CONSOLIDATED",
    coverage: 0.8,
    filedAt: new Date(periodEnd.getTime() + 60 * 86_400_000),
    sourceUrl: "https://nse/CONSOLIDATED.xml",
    facts: {
      family: "ind-as",
      basis: "CONSOLIDATED",
      period: {
        start: "2024-04-01",
        end: "2025-03-31",
        days: 365,
      },
      values: {
        revenueFromOperations: revenue,
        profitForPeriod: revenue * 0.1,
        totalAssets: revenue * 2,
        totalEquity: revenue,
        paidUpEquityShareCapital: revenue / 1_000,
        faceValuePerShare: 10,
      },
    },
  };
}

interface Store {
  ratios: Row[];
  upserts: Array<{ symbol: string; update: Row }>;
  cursorStamps: number;
}

function fakePrisma(store: Store) {
  const instrument = { id: "i-a", symbol: "AAA", exchange: "NSE" };
  const prices = Array.from({ length: 501 }, (_, k) => ({
    date: day(1 + (500 - k)),
    close: 100 + (k % 7),
  }));
  const indexCloses = prices.map((p) => ({ date: p.date, close: 20_000 }));
  return {
    instrumentMapping: { findMany: async () => [instrument] },
    stockRatios: {
      findMany: async () =>
        store.ratios.map((r) => ({
          symbol: r.symbol,
          exchange: r.exchange,
          ratiosDerivedAt: (r.ratiosDerivedAt as Date | undefined) ?? null,
        })),
      findUnique: async () => store.ratios[0] ?? null,
      upsert: async (args: {
        where: { symbol_exchange: { symbol: string } };
        create: Row;
        update: Row;
      }) => {
        store.upserts.push({
          symbol: args.where.symbol_exchange.symbol,
          update: args.update,
        });
        Object.assign(store.ratios[0]!, args.update);
        return {};
      },
      updateMany: async (args: { data: Row }) => {
        store.cursorStamps++;
        Object.assign(store.ratios[0]!, args.data);
        return { count: 1 };
      },
    },
    xbrlFiling: { findMany: async () => [filing()] },
    dailyPrice: { findMany: async () => prices },
    indexClose: { findMany: async () => indexCloses },
    corporateAction: { findMany: async () => [] },
  } as never;
}

function emptyStore(): Store {
  return {
    ratios: [{ symbol: "AAA", exchange: "NSE", source: "TICKERTAPE" }],
    upserts: [],
    cursorStamps: 0,
  };
}

const ENV_KEYS = ["XBRL_RATIOS_APPLY", "XBRL_PROJECTION_APPLY"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(patch: Record<string, string>): void {
  for (const k of ENV_KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe("processXbrlRatios obeys XBRL_RATIOS_APPLY, not the projection's flag", () => {
  it("WRITES under RATIOS=true + PROJECTION=false — the shipping target", async () => {
    // THE MUTATION TARGET. Point `isRatiosArmed` back at
    // `XBRL_PROJECTION_APPLY` and this case reports `applied:false` with zero
    // upserts: the exact configuration MONEY-1286 exists to make reachable
    // becomes unreachable again, and nothing else in the suite notices.
    setEnv({ XBRL_RATIOS_APPLY: "true", XBRL_PROJECTION_APPLY: "false" });
    const store = emptyStore();
    const result = await processXbrlRatios(
      { limit: 1 },
      { prisma: fakePrisma(store), now: NOW },
    );
    assert.equal(result.applied, true, "the run must report itself as armed");
    assert.equal(result.written, 1);
    assert.equal(store.upserts.length, 1, "the row must actually be written");
    assert.equal(store.upserts[0]!.update.source, "NSE_XBRL");
    // The rotation cursor only advances on an ARMED run, so it doubles as
    // proof that the write path — not just the counter — was taken.
    assert.equal(result.cursorStamped, 1);
  });

  it("DRY-RUNS under RATIOS=false + PROJECTION=true — the inverse", async () => {
    setEnv({ XBRL_RATIOS_APPLY: "false", XBRL_PROJECTION_APPLY: "true" });
    const store = emptyStore();
    const result = await processXbrlRatios(
      { limit: 1 },
      { prisma: fakePrisma(store), now: NOW },
    );
    assert.equal(
      result.applied,
      false,
      "the projection's arm must not arm this job",
    );
    assert.equal(store.upserts.length, 0, "a dry run must mutate nothing");
    assert.equal(store.cursorStamps, 0, "the cursor must not advance either");
    // `written` on a dry run is "what WOULD land", which is why `applied` and
    // the store are both asserted above rather than this counter alone.
    assert.equal(result.written, 1);
  });

  it("names the RIGHT switch in the outcome line, so a log reader can tell", async () => {
    // Two arms means "not armed" is now ambiguous unless the reason says which
    // one. The projection job emits the same sentence for its own flag.
    const src = read("workers/src/processors/xbrl-ratios.ts");
    assert.match(src, /not-armed \(XBRL_RATIOS_APPLY !== 'true'\)/);
    assert.doesNotMatch(
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""),
      /XBRL_PROJECTION_APPLY/,
      "the ratios processor must not reference the projection's flag at all",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* DEPLOY CONTRACT                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What each flag SHIPS as, per environment. Change a value here only together
 * with the spec, and say why in the commit — a flag that drifts silently is the
 * whole reason this table exists.
 *
 * Both are `"false"` today. Prod's `XBRL_RATIOS_APPLY` flips to `"true"` once
 * MONEY-1288 widens the gate; QA stays `"false"` because a QA write would be
 * replaced by the next `sync-prod-to-qa` restore regardless.
 */
const INTENDED_FLAG_STATE: Record<"prod" | "qa", Record<string, string>> = {
  prod: {
    XBRL_PROJECTION_APPLY: "false",
    XBRL_RATIOS_APPLY: "false",
    // MONEY-1346. Ships off in both, like its two neighbours — but its flip is
    // gated on DIFFERENT evidence: the extract-only cohort has no incumbent
    // row, so its writes are pure CREATEs and displace nothing.
    DOC_RATIOS_APPLY: "false",
  },
  qa: {
    XBRL_PROJECTION_APPLY: "false",
    XBRL_RATIOS_APPLY: "false",
    DOC_RATIOS_APPLY: "false",
  },
};

const SPEC: Record<"prod" | "qa", string> = { prod: CB_PROD, qa: CB_QA };

/**
 * Every `- name: X` / `value: "y"` pair in a spec's container env block.
 *
 * Parsed rather than substring-matched, because the failure this guards against
 * is a DUPLICATE declaration: Knative takes the last entry, so a second
 * `XBRL_RATIOS_APPLY` further down silently overrides the first and a
 * `spec.includes('value: "false"')` test would still pass.
 */
function envEntries(spec: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = spec.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*- name: ([A-Z0-9_]+)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const v = /^\s*value: "?([^"\n]*)"?\s*$/.exec(lines[i + 1] ?? "");
    // A `valueFrom:` secret is recorded as such so a switch that turns into a
    // secret reference fails loudly instead of reading as absent.
    const value = v ? v[1]! : "<valueFrom>";
    const prev = out.get(m[1]!) ?? [];
    prev.push(value);
    out.set(m[1]!, prev);
  }
  return out;
}

/**
 * The arming flags the two XBRL processors ACTUALLY read, derived from source.
 *
 * Derived, never listed, so a third switch appearing in either processor fails
 * this file until somebody states what it ships as per environment — rather
 * than defaulting into whichever value the spec happened to get.
 */
function armingFlagsInCode(): Set<string> {
  const found = new Set<string>();
  for (const f of [
    "workers/src/processors/xbrl-ratios.ts",
    "workers/src/processors/xbrl-projection.ts",
  ]) {
    const src = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // NOT anchored on `XBRL_` — MONEY-1346 added `DOC_RATIOS_APPLY` to this
    // very file, and a prefix-scoped pattern would have skipped it silently,
    // which is exactly the "a third switch appears and defaults into whatever
    // the spec happened to get" failure this mechanism exists to prevent.
    for (const m of src.matchAll(/env\.([A-Z0-9_]*APPLY)\s*===\s*"true"/g)) {
      found.add(m[1]!);
    }
  }
  return found;
}

describe("deploy contract — both arms ship PRESENT, at their intended value", () => {
  it("the intended-state table covers every arming flag the code reads", () => {
    const derived = armingFlagsInCode();
    assert.ok(
      derived.size > 0,
      "premise: no arming flags found in the sources",
    );
    assert.deepEqual(
      [...derived].sort(),
      ["DOC_RATIOS_APPLY", "XBRL_PROJECTION_APPLY", "XBRL_RATIOS_APPLY"],
      "the two processors must read exactly these three flags",
    );
    for (const env of ["prod", "qa"] as const) {
      assert.deepEqual(
        Object.keys(INTENDED_FLAG_STATE[env]).sort(),
        [...derived].sort(),
        `INTENDED_FLAG_STATE.${env} does not match the flags the code reads`,
      );
    }
  });

  for (const env of ["prod", "qa"] as const) {
    it(`cloudbuild.${env}.yaml declares both, exactly once, at the intended value`, () => {
      const entries = envEntries(SPEC[env]);
      for (const [flag, intended] of Object.entries(INTENDED_FLAG_STATE[env])) {
        const values = entries.get(flag);
        assert.ok(
          values !== undefined,
          `cloudbuild.${env}.yaml omits ${flag}. Absent and explicitly-set ` +
            "behave the same and read completely differently — that is how " +
            "MF_METADATA_PROVIDER disabled its job silently for months " +
            "(MONEY-1214).",
        );
        assert.equal(
          values.length,
          1,
          `${flag} is declared ${values.length} times in cloudbuild.${env}.yaml; ` +
            "Knative keeps the LAST entry, so a duplicate is a silent override.",
        );
        assert.equal(
          values[0],
          intended,
          `cloudbuild.${env}.yaml ships ${flag}="${values[0]}"; the intended ` +
            `posture is "${intended}". Both directions matter: a silent DISARM ` +
            "of prod is as much a defect as an accidental arming, and neither " +
            "produces an error anywhere else.",
        );
        assert.notEqual(
          values[0],
          "<valueFrom>",
          `${flag} is a switch an operator must read at a glance, not a secret`,
        );
        assert.notEqual(values[0], "", `${flag} empty reads as absent`);
      }
    });

    it(`cloudbuild.${env}.yaml's armed literal is byte-identical to the code's`, () => {
      // A flag set to "True" reads as armed to a human and is off in the code.
      // Only enforceable on the armed side, so it is checked as an implication.
      const entries = envEntries(SPEC[env]);
      for (const flag of Object.keys(INTENDED_FLAG_STATE[env])) {
        const value = entries.get(flag)?.[0];
        if (value?.toLowerCase() === "true") {
          assert.equal(
            value,
            "true",
            `${flag}="${value}" is not the literal the processor compares to`,
          );
        }
      }
    });
  }

  it("the drain JOB keeps the PROJECTION flag — it runs the projection", () => {
    // `setup-xbrl-projection-drain-job.sh` provisions a Cloud Run JOB that
    // calls `processXbrlProjectionWrite`. It must stay on
    // XBRL_PROJECTION_APPLY: pointing it at the ratios flag would arm a
    // StockFinancials drain from the switch whose evidence is about
    // StockRatios, which is the coupling this ticket removed running backwards.
    const sh = read("scripts/ops/setup-xbrl-projection-drain-job.sh");
    assert.match(sh, /XBRL_PROJECTION_APPLY=\$\{APPLY_ENV_VALUE\}/);
    assert.doesNotMatch(sh, /XBRL_RATIOS_APPLY/);
  });
});
