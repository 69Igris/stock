/**
 * The Databento spend guard — MONEY-1373.
 *
 * The cases that carry weight are the refusals. A budget guard that authorises
 * when it cannot tell is worse than no guard at all, because it manufactures
 * headroom nobody checks — the MONEY-1309 lesson, where a guard wired at one of
 * five legs under-reported spend by ~80%.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DATABENTO_MONTHLY_BUDGET_USD,
  DatabentoBudgetExceededError,
  __resetDatabentoBudgetWarning,
  formatBudgetLine,
  monthWindowUtc,
  readDatabentoMonthlyBudgetUsd,
  reportQuoteDrift,
  withDatabentoBudget,
  type BudgetSpec,
  type DatabentoBudgetDeps,
  type DatabentoJobRow,
} from "../../src/market-data/databento/databento-budget";
import type { DatabentoJob } from "../../src/market-data/databento/databento-logic";

/* ── harness ───────────────────────────────────────────────────────────── */

const JOB: DatabentoJob = {
  id: "EQUS-20260906-ABC",
  dataset: "EQUS.MINI",
  schema: "ohlcv-1m",
  symbols: "AAPL",
  start: "2024-01-02T00:00:00Z",
  end: "2024-01-03T00:00:00Z",
  state: "queued",
  tsReceived: "2026-09-06T00:00:00Z",
  costUsd: null,
  recordCount: null,
  billedSize: null,
  actualSize: null,
  packageSize: null,
  tsExpiration: null,
  progress: null,
};

const SPEC: BudgetSpec = {
  purpose: "HARVEST",
  entryId: "ohlcv-1m-baseline",
  schema: "ohlcv-1m",
  symbolsHash: "hash-1",
  start: new Date("2024-01-02T00:00:00Z"),
  end: new Date("2024-01-03T00:00:00Z"),
  dataset: "EQUS.MINI",
  symbolCount: 1,
  request: {
    dataset: "EQUS.MINI",
    symbols: ["AAPL"],
    schema: "ohlcv-1m",
    start: new Date("2024-01-02T00:00:00Z"),
    end: new Date("2024-01-03T00:00:00Z"),
    // REQUIRED since MONEY-1375: the guard carries the request it authorises,
    // and the split shape is part of what was authorised.
    splitSymbols: true,
    splitDuration: "year",
  },
  apply: true,
};

function deps(o: { existing?: DatabentoJobRow | null; spent?: number } = {}) {
  const created: unknown[] = [];
  const submitted: string[] = [];
  const failed: Array<{ id: string; detail: string }> = [];
  const row: DatabentoJobRow = {
    id: "row-1",
    jobId: null,
    state: "QUOTED",
    costUsd: null,
    costUsdQuoted: 0,
  };
  const d: DatabentoBudgetDeps = {
    async findExistingJob() {
      return o.existing ?? null;
    },
    async sumMonthSpendUsd() {
      return o.spent ?? 0;
    },
    async createQuotedJob(args) {
      created.push(args);
      row.costUsdQuoted = args.costUsdQuoted;
      return row;
    },
    async markSubmitted(id) {
      submitted.push(id);
    },
    async markFailed(id, detail) {
      failed.push({ id, detail });
    },
    now: () => new Date("2026-09-06T12:00:00Z"),
  };
  return { d, created, submitted, failed, row };
}

beforeEach(() => {
  delete process.env["DATABENTO_MONTHLY_BUDGET_USD"];
  __resetDatabentoBudgetWarning();
});

/* ── the budget value ──────────────────────────────────────────────────── */

describe("the monthly budget is read PER CALL", () => {
  it("defaults when unset", () => {
    assert.equal(
      readDatabentoMonthlyBudgetUsd(),
      DEFAULT_DATABENTO_MONTHLY_BUDGET_USD,
    );
  });

  it("sees a value that changed after import — never a frozen module const", () => {
    // A module-scope read freezes at import, and on a warm Cloud Run container
    // that turns a redeployed budget into no change at all.
    process.env["DATABENTO_MONTHLY_BUDGET_USD"] = "60";
    assert.equal(readDatabentoMonthlyBudgetUsd(), 60);
    process.env["DATABENTO_MONTHLY_BUDGET_USD"] = "10";
    assert.equal(readDatabentoMonthlyBudgetUsd(), 10);
  });

  it("falls back on a value that is not a positive number", () => {
    for (const bad of ["nope", "0", "-5", ""]) {
      process.env["DATABENTO_MONTHLY_BUDGET_USD"] = bad;
      assert.equal(
        readDatabentoMonthlyBudgetUsd(),
        DEFAULT_DATABENTO_MONTHLY_BUDGET_USD,
        `"${bad}" should fall back`,
      );
    }
  });
});

describe("monthWindowUtc", () => {
  it("spans the calendar month, half-open", () => {
    const w = monthWindowUtc(new Date("2026-09-06T12:00:00Z"));
    assert.equal(new Date(w.fromMs).toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(new Date(w.toMs).toISOString(), "2026-10-01T00:00:00.000Z");
  });

  it("rolls the year at December", () => {
    const w = monthWindowUtc(new Date("2026-12-31T23:59:59Z"));
    assert.equal(new Date(w.toMs).toISOString(), "2027-01-01T00:00:00.000Z");
  });
});

/* ── the guard ─────────────────────────────────────────────────────────── */

describe("withDatabentoBudget — a window is never bought twice", () => {
  it("returns the existing row WITHOUT quoting or submitting", async () => {
    const existing: DatabentoJobRow = {
      id: "row-0",
      jobId: "EQUS-OLD",
      state: "LOADED",
      costUsd: 3,
      costUsdQuoted: 3,
    };
    const h = deps({ existing });
    let quoted = 0;
    let submits = 0;
    const out = await withDatabentoBudget(
      SPEC,
      h.d,
      async () => {
        quoted++;
        return 99;
      },
      async () => {
        submits++;
        return JOB;
      },
    );
    assert.equal(out.status, "reused");
    // The point: a killed task's re-run, or an operator repeating a manifest
    // entry, spends nothing.
    assert.equal(quoted, 0);
    assert.equal(submits, 0);
  });

  it("RETRIES a window whose previous attempt FAILED", async () => {
    const existing: DatabentoJobRow = {
      id: "row-0",
      jobId: null,
      state: "FAILED",
      costUsd: null,
      costUsdQuoted: 0,
    };
    const h = deps({ existing });
    const out = await withDatabentoBudget(
      SPEC,
      h.d,
      async () => 1,
      async () => JOB,
    );
    assert.equal(out.status, "submitted");
  });

  it("TAKES OVER a stale QUOTED row instead of inserting beside it", async () => {
    // MONEY-1539. An insert with the same window collides with the
    // `@@unique`, so every 18:00 IST retry of a chunk the 15:00 run left
    // QUOTED died on a unique-constraint error and the chunk was never bought.
    for (const state of ["QUOTED", "FAILED"]) {
      const h = deps({
        existing: {
          id: "row-0",
          jobId: null,
          state,
          costUsd: null,
          costUsdQuoted: 0,
        },
      });
      await withDatabentoBudget(
        SPEC,
        h.d,
        async () => 1,
        async () => JOB,
      );
      assert.equal(
        (h.created[0] as { reclaimRowId: string | null }).reclaimRowId,
        "row-0",
        `${state} row was re-inserted rather than taken over`,
      );
    }
  });

  it("never takes over a row that carries a job id — its bytes would lose their row", async () => {
    // MONEY-1540's shape: an archived job whose ledger row no longer names it.
    // Re-arming an EXPIRED row would overwrite its jobId on submit.
    const h = deps({
      existing: {
        id: "row-0",
        jobId: "EQUS-OLD",
        state: "EXPIRED",
        costUsd: 0,
        costUsdQuoted: 0,
      },
    });
    await withDatabentoBudget(
      SPEC,
      h.d,
      async () => 1,
      async () => JOB,
    );
    assert.equal(
      (h.created[0] as { reclaimRowId: string | null }).reclaimRowId,
      null,
    );
  });

  it("a brand-new window inserts", async () => {
    const h = deps();
    await withDatabentoBudget(
      SPEC,
      h.d,
      async () => 1,
      async () => JOB,
    );
    assert.equal(
      (h.created[0] as { reclaimRowId: string | null }).reclaimRowId,
      null,
    );
  });

  it("RETRIES a window whose files EXPIRED — the 30-day download window closed", async () => {
    const existing: DatabentoJobRow = {
      id: "row-0",
      jobId: "OLD",
      state: "EXPIRED",
      costUsd: 2,
      costUsdQuoted: 2,
    };
    const h = deps({ existing });
    const out = await withDatabentoBudget(
      SPEC,
      h.d,
      async () => 1,
      async () => JOB,
    );
    assert.equal(out.status, "submitted");
  });
});

describe("withDatabentoBudget — over budget REFUSES, and never trims", () => {
  it("throws with all three numbers when the quote would exceed the budget", async () => {
    process.env["DATABENTO_MONTHLY_BUDGET_USD"] = "25";
    const h = deps({ spent: 20 });
    let submits = 0;
    await assert.rejects(
      () =>
        withDatabentoBudget(
          SPEC,
          h.d,
          async () => 10,
          async () => {
            submits++;
            return JOB;
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof DatabentoBudgetExceededError);
        assert.equal(err.quoteUsd, 10);
        assert.equal(err.spentUsd, 20);
        assert.equal(err.budgetUsd, 25);
        assert.match(err.message, /Not trimming/);
        return true;
      },
    );
    // Nothing was submitted, and no row was created — a refusal is not spend.
    assert.equal(submits, 0);
    assert.equal(h.created.length, 0);
  });

  it("allows a spend that lands EXACTLY on the budget", async () => {
    process.env["DATABENTO_MONTHLY_BUDGET_USD"] = "25";
    const h = deps({ spent: 20 });
    const out = await withDatabentoBudget(
      SPEC,
      h.d,
      async () => 5,
      async () => JOB,
    );
    assert.equal(out.status, "submitted");
  });

  it("refuses one cent over", async () => {
    process.env["DATABENTO_MONTHLY_BUDGET_USD"] = "25";
    const h = deps({ spent: 20 });
    await assert.rejects(
      () =>
        withDatabentoBudget(
          SPEC,
          h.d,
          async () => 5.01,
          async () => JOB,
        ),
      DatabentoBudgetExceededError,
    );
  });

  it("a zero quote — an INCLUDED window under the subscription — always passes", async () => {
    process.env["DATABENTO_MONTHLY_BUDGET_USD"] = "25";
    const h = deps({ spent: 25 });
    const out = await withDatabentoBudget(
      SPEC,
      h.d,
      async () => 0,
      async () => JOB,
    );
    assert.equal(out.status, "submitted");
  });
});

describe("withDatabentoBudget — dry run is the default posture", () => {
  it("quotes, compares, and creates NOTHING", async () => {
    const h = deps({ spent: 4 });
    let submits = 0;
    const out = await withDatabentoBudget(
      { ...SPEC, apply: false },
      h.d,
      async () => 1.5,
      async () => {
        submits++;
        return JOB;
      },
    );
    assert.equal(out.status, "dry-run");
    assert.equal(out.status === "dry-run" && out.quoteUsd, 1.5);
    assert.equal(out.status === "dry-run" && out.spentUsd, 4);
    assert.equal(submits, 0);
    assert.equal(h.created.length, 0);
  });

  it("still REFUSES over budget in dry run — the report must not be rosier than the run", async () => {
    process.env["DATABENTO_MONTHLY_BUDGET_USD"] = "5";
    const h = deps({ spent: 4 });
    await assert.rejects(
      () =>
        withDatabentoBudget(
          { ...SPEC, apply: false },
          h.d,
          async () => 2,
          async () => JOB,
        ),
      DatabentoBudgetExceededError,
    );
  });
});

describe("withDatabentoBudget — the write order survives a crash at any point", () => {
  it("creates the row BEFORE submitting and marks it after", async () => {
    const h = deps();
    const order: string[] = [];
    const d: DatabentoBudgetDeps = {
      ...h.d,
      async createQuotedJob(args) {
        order.push("create");
        return h.d.createQuotedJob(args);
      },
      async markSubmitted(id, job) {
        order.push("markSubmitted");
        return h.d.markSubmitted(id, job);
      },
    };
    await withDatabentoBudget(
      SPEC,
      d,
      async () => 1,
      async () => {
        order.push("submit");
        return JOB;
      },
    );
    // Submitting first would lose the job id on a crash, and a job that exists
    // at the vendor and not in our ledger is spend nobody can find.
    assert.deepEqual(order, ["create", "submit", "markSubmitted"]);
  });

  it("marks the row FAILED when the submission throws, so the window can be retried", async () => {
    const h = deps();
    await assert.rejects(
      () =>
        withDatabentoBudget(
          SPEC,
          h.d,
          async () => 1,
          async () => {
            throw new Error("vendor 503");
          },
        ),
      /vendor 503/,
    );
    assert.equal(h.failed.length, 1);
    assert.match(h.failed[0]!.detail, /vendor 503/);
    // A row left in QUOTED would be neither spend nor work, and the idempotent
    // lookup would skip it forever.
    assert.equal(h.submitted.length, 0);
  });

  it("records the QUOTE on the row — cost_usd is null until the vendor processes it", async () => {
    const h = deps();
    await withDatabentoBudget(
      SPEC,
      h.d,
      async () => 7.25,
      async () => JOB,
    );
    assert.equal(
      (h.created[0] as { costUsdQuoted: number }).costUsdQuoted,
      7.25,
    );
  });
});

/* ── reporting ─────────────────────────────────────────────────────────── */

describe("the money line a run prints", () => {
  it("says what a dry run WOULD spend", () => {
    const line = formatBudgetLine({
      entryId: "ohlcv-1m-baseline",
      outcome: { status: "dry-run", quoteUsd: 1.5, spentUsd: 4, budgetUsd: 25 },
    });
    assert.match(line, /DRY RUN quote \$1\.50/);
    assert.match(line, /budget \$25\.00/);
  });

  it("names a reuse as spending nothing", () => {
    const line = formatBudgetLine({
      entryId: "e",
      outcome: {
        status: "reused",
        row: {
          id: "r",
          jobId: "J",
          state: "LOADED",
          costUsd: 1,
          costUsdQuoted: 1,
        },
        quoteUsd: 1,
      },
    });
    assert.match(line, /already bought/);
    assert.match(line, /no spend/);
  });
});

describe("quote drift is a WARNING, not a guard", () => {
  it("is silent while the vendor has not billed yet", () => {
    assert.equal(
      reportQuoteDrift({
        entryId: "e",
        jobId: "J",
        quotedUsd: 5,
        actualUsd: null,
      }),
      null,
    );
  });

  it("is silent within a cent", () => {
    assert.equal(
      reportQuoteDrift({
        entryId: "e",
        jobId: "J",
        quotedUsd: 5,
        actualUsd: 5.005,
      }),
      null,
    );
  });

  it("names both numbers when they diverge", () => {
    // By the time the real cost is known the money is spent — so this is not a
    // guard. It is the only thing that would ever say the budget is being
    // enforced against the wrong number.
    const line = reportQuoteDrift({
      entryId: "ohlcv-1h-master",
      jobId: "J",
      quotedUsd: 5,
      actualUsd: 45,
    });
    assert.match(line ?? "", /QUOTE DRIFT/);
    assert.match(line ?? "", /quoted \$5\.00, billed \$45\.00/);
  });
});
