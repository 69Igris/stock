/**
 * `filing-registry-sync` must cost ONE target scan per run — MONEY-1533.
 *
 * ## What this file exists to stop
 *
 * The job used to issue one `MERGE ... USING UNNEST(@rows)` per 2,000-row chunk
 * of every 5,000-row Mongo page. A MERGE with an UPDATE clause bills the whole
 * target table every time, so the bill grew with the SQUARE of the table:
 * ~28.5 TiB for one full walk of prod's 18,765,482 filings (the arithmetic is
 * in the job's header). MONEY-1517 (B6) needs exactly that full walk before it
 * may delete anything from `us_filings`.
 *
 * Every property here only shows up ACROSS pages — the MERGE count, the load
 * count, which of two staged copies wins — so the tests drive the whole
 * orchestration through a fake BigQuery + GCS: statements recorded, objects
 * kept in a map, and the load answering with the rows its wildcard actually
 * matches, so a stage object outside the wildcard is caught as a short load.
 *
 * The SQL half of the dedupe (`QUALIFY ... ORDER BY stage_seq DESC`) was run
 * against real BigQuery on literal rows, and both the staging DDL and the MERGE
 * were dry-run against `lake_silver_prod` (2026-09-23, nothing billed or
 * created). A fake cannot execute SQL, so the MERGE text is pinned here and
 * the semantics were measured there.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  STAGE_ROWS,
  STAGE_TTL_HOURS,
  buildCreateStagingSql,
  buildMergeSql,
  logicalBytes,
  stagingTableName,
  syncFilingRegistry,
  type RegistryIO,
  type Statement,
} from "../../../scripts/jobs/filing-registry-sync-logic.mjs";
import {
  toFilingRegistryRow,
  type FilingRegistryRow,
} from "@usemoney/lake/events-logic";

const RUN = "filing-registry-sync-2026-09-23T10-00-00-000Z";
const BASE = {
  projectId: "p",
  dataset: "lake_silver_qa",
  bucket: "stockbook-lake-qa",
  runId: RUN,
  log: () => {},
};
const STAGE = `\`p.lake_silver_qa.${stagingTableName(RUN)}\``;

/** A row exactly as the job produces it, through the real mapper. */
function row(accession: string, status = "PARSED"): FilingRegistryRow {
  return toFilingRegistryRow(
    {
      accession,
      cik10: "0000320193",
      form: "8-K",
      filedAt: new Date("2026-09-02T00:00:00.000Z"),
      acceptedAt: new Date("2026-09-01T21:53:00.000Z"),
      periodOfReport: null,
      items: ["2.02"],
      primaryDocument: "a.htm",
      isXbrl: false,
      isInlineXbrl: false,
      sizeBytes: 10,
      parseClass: "EIGHTK",
      status,
      rawPath: null,
    },
    null,
  );
}

async function* pagesOf(
  pages: readonly FilingRegistryRow[][],
): AsyncGenerator<FilingRegistryRow[]> {
  for (const p of pages) yield p;
}

/** `n` rows in pages of `size`. */
function walk(n: number, size: number, tag = "A"): FilingRegistryRow[][] {
  const out: FilingRegistryRow[][] = [];
  for (let i = 0; i < n; i += size) {
    out.push(
      Array.from({ length: Math.min(size, n - i) }, (_, k) =>
        row(`${tag}-${i + k}`),
      ),
    );
  }
  return out;
}

const isMerge = (s: Statement) => s.sql.startsWith("MERGE") && !s.dryRun;
const isDrop = (s: Statement) => s.sql.startsWith("DROP TABLE");

function fakeIO(fail: { merge?: boolean; drop?: boolean } = {}) {
  const statements: Statement[] = [];
  const objects = new Map<string, string>();
  const loads: { table: string; uri: string }[] = [];
  const io: RegistryIO = {
    async query(s) {
      statements.push(s);
      if (fail.merge && isMerge(s)) throw new Error("merge exploded");
      if (fail.drop && isDrop(s)) throw new Error("drop denied");
      return {
        bytesProcessed: s.dryRun ? 4_242 : 0,
        bytesBilled: s.dryRun ? 0 : 4_242,
        affectedRows: 0,
      };
    },
    async upload(key, ndjson) {
      objects.set(key, ndjson);
    },
    async load(table, uri) {
      loads.push({ table, uri });
      // What BigQuery would read: every object under the wildcard's prefix.
      const prefix = uri.replace(/^gs:\/\/[^/]+\//, "").replace(/\*$/, "");
      let n = 0;
      for (const [key, body] of objects) {
        if (key.startsWith(prefix))
          n += body.split("\n").filter(Boolean).length;
      }
      return n;
    },
  };
  return { io, statements, objects, loads };
}

/** Every staged row, tagged with the object key it was written to. */
function stagedRows(objects: Map<string, string>): Record<string, unknown>[] {
  return [...objects.entries()].flatMap(([key, body]) =>
    body
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ ...(JSON.parse(l) as Record<string, unknown>), key })),
  );
}

describe("MONEY-1533 — one MERGE per run, not one per chunk", () => {
  it("(a) issues exactly ONE MERGE whatever the number of pages", async () => {
    for (const pages of [1, 7, 40]) {
      const f = fakeIO();
      await syncFilingRegistry({
        ...BASE,
        pages: pagesOf(walk(pages * 3, 3)),
        io: f.io,
        stageRows: 4,
      });
      assert.equal(f.statements.filter(isMerge).length, 1, `${pages} pages`);
      // ...priced once, before it runs.
      const dry = f.statements.filter((s) => s.dryRun);
      assert.equal(dry.length, 1);
      assert.equal(dry[0]!.sql, f.statements.find(isMerge)!.sql);
    }
  });

  it("the MERGE reads the staging table, not a per-chunk parameter", async () => {
    const f = fakeIO();
    await syncFilingRegistry({ ...BASE, pages: pagesOf(walk(5, 2)), io: f.io });
    const merge = f.statements.find(isMerge)!;
    assert.match(
      merge.sql,
      new RegExp(`FROM ${STAGE.replace(/[.`]/g, "\\$&")} s`),
    );
    assert.doesNotMatch(merge.sql, /UNNEST\(@rows\)/);
    assert.deepEqual(Object.keys(merge.params ?? {}).sort(), [
      "ingested_at",
      "parser_version",
      "run_id",
    ]);
  });
});

describe("MONEY-1533 — staging loads stay far below BigQuery's load limits", () => {
  it("(b) any walk is ~stageRows-row objects read by ONE load job", async () => {
    for (const n of [1, 4, 5, 23, 100]) {
      const f = fakeIO();
      const r = await syncFilingRegistry({
        ...BASE,
        pages: pagesOf(walk(n, 3)),
        io: f.io,
        stageRows: 4,
      });
      assert.equal(f.loads.length, 1, `${n} rows -> one load job`);
      assert.equal(f.loads[0]!.table, stagingTableName(RUN));
      assert.match(f.loads[0]!.uri, /^gs:\/\/stockbook-lake-qa\/lake\/stage\//);
      assert.equal(r.objects, f.objects.size);
      // Flushed at >= stageRows, so an object is never smaller than that
      // except the last one: pages of 3 against 4 -> 6-row objects.
      assert.equal(r.objects, Math.ceil(n / 6));
      assert.equal(stagedRows(f.objects).length, n);
    }
  });

  it("(b) prod's 18,765,482-row walk: 188 objects, 1 load job", () => {
    // BigQuery: 1,500 load jobs per table per day; 10,000,000 source files per
    // load job. The load count is 1 by construction (above), so what remains
    // to pin is that the object count fits one job.
    const objects = Math.ceil(18_765_482 / STAGE_ROWS);
    assert.equal(objects, 188);
    assert.ok(objects <= 10_000_000);
  });

  it("refuses to MERGE when the load wrote fewer rows than were staged", async () => {
    const f = fakeIO();
    f.io.load = async () => 2; // a wildcard that missed an object
    await assert.rejects(
      syncFilingRegistry({ ...BASE, pages: pagesOf(walk(3, 3)), io: f.io }),
      /staged 3 rows .* the load wrote 2 .* refusing to MERGE a partial stage/,
    );
    assert.equal(
      f.statements.filter((s) => s.sql.startsWith("MERGE")).length,
      0,
    );
  });
});

describe("MONEY-1533 — the dedupe holds ACROSS stage objects", () => {
  it("(c) an accession staged twice keeps the LATER copy, wherever it landed", async () => {
    const f = fakeIO();
    await syncFilingRegistry({
      ...BASE,
      // X is walked second in object 0 and FIRST in object 2: a per-object
      // counter would rank the stale copy above the fresh one.
      pages: pagesOf([
        [row("Y"), row("X", "DETECTED")],
        [row("Z"), row("W")],
        [row("X", "PARSED")],
      ]),
      io: f.io,
      stageRows: 2,
    });
    const staged = stagedRows(f.objects);
    const old = staged.find(
      (r) => r.accession === "X" && r.status === "DETECTED",
    )!;
    const fresh = staged.find(
      (r) => r.accession === "X" && r.status === "PARSED",
    )!;
    assert.notEqual(
      old.key,
      fresh.key,
      "the two copies must be in different objects",
    );
    assert.ok(
      (fresh.stage_seq as number) > (old.stage_seq as number),
      "the later copy must carry the higher stage_seq",
    );
    // `stage_seq` is the walk position — unique across the whole run.
    assert.deepEqual(
      staged.map((r) => r.stage_seq).sort((a, b) => Number(a) - Number(b)),
      [0, 1, 2, 3, 4],
    );
    // ...and the MERGE keeps exactly the highest one per accession.
    assert.match(
      f.statements.find(isMerge)!.sql,
      /QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY accession ORDER BY stage_seq DESC\) = 1/,
    );
  });
});

describe("MONEY-1533 — the staging table is run-scoped and disposable", () => {
  it("(d) created FIRST with an expiration, dropped after the MERGE", async () => {
    const f = fakeIO();
    await syncFilingRegistry({ ...BASE, pages: pagesOf(walk(3, 2)), io: f.io });
    const sqls = f.statements.map((s) => s.sql);
    // A bare CREATE: a second run with the same id FAILS instead of sharing.
    assert.ok(sqls[0]!.startsWith(`CREATE TABLE ${STAGE} (`), sqls[0]);
    assert.match(
      sqls[0]!,
      new RegExp(
        `expiration_timestamp = TIMESTAMP_ADD\\(CURRENT_TIMESTAMP\\(\\), INTERVAL ${STAGE_TTL_HOURS} HOUR\\)`,
      ),
    );
    assert.equal(sqls.at(-1), `DROP TABLE ${STAGE}`);
    assert.ok(f.statements.findIndex(isMerge) < sqls.length - 1);
  });

  it("a failed MERGE fails the run and KEEPS the table for its post-mortem", async () => {
    const f = fakeIO({ merge: true });
    await assert.rejects(
      syncFilingRegistry({ ...BASE, pages: pagesOf(walk(3, 2)), io: f.io }),
      /merge exploded/,
    );
    assert.equal(f.statements.filter(isDrop).length, 0);
  });

  it("a failed DROP after a good MERGE is a warning: the table expires anyway", async () => {
    const f = fakeIO({ drop: true });
    const lines: string[] = [];
    const r = await syncFilingRegistry({
      ...BASE,
      pages: pagesOf(walk(3, 2)),
      io: f.io,
      log: (l) => lines.push(l),
    });
    assert.ok(r.merge);
    assert.ok(lines.some((l) => /^WARN could not drop .*drop denied/.test(l)));
  });

  it("an empty walk drops the table with no load and no MERGE", async () => {
    const f = fakeIO();
    const r = await syncFilingRegistry({
      ...BASE,
      pages: pagesOf([]),
      io: f.io,
    });
    assert.equal(r.merge, null);
    assert.equal(f.loads.length, 0);
    assert.deepEqual(
      f.statements.map((s) => s.sql.split(" ").slice(0, 2).join(" ")),
      ["CREATE TABLE", "DROP TABLE"],
    );
  });

  it("each run id names its own valid BigQuery table", () => {
    const a = stagingTableName(RUN);
    const b = stagingTableName("filing-registry-sync-2026-09-23T10-00-00-001Z");
    assert.notEqual(a, b);
    for (const n of [a, b]) assert.match(n, /^[a-z][a-z0-9_]{0,127}$/);
  });
});

describe("MONEY-1533 — the staged shape is the loaded shape", () => {
  it("every NDJSON key is a staging column and every column is a key", async () => {
    // `loadNdjson` refuses an unknown field and a missing one lands as NULL —
    // both only at the END of an hour-long walk, so they are caught here.
    const f = fakeIO();
    await syncFilingRegistry({ ...BASE, pages: pagesOf(walk(1, 1)), io: f.io });
    const line = JSON.parse(
      [...f.objects.values()][0]!.split("\n")[0]!,
    ) as object;
    const cols = [
      ...buildCreateStagingSql("`t`").matchAll(/^ {2}(\w+) /gm),
    ].map((m) => m[1]);
    assert.deepEqual(Object.keys(line).sort(), cols.sort());
  });

  it("the MERGE inserts exactly filing_registry's DDL columns, in DDL order", () => {
    const ddl = readFileSync(
      new URL(
        "../../../packages/lake/ddl/008_silver_instrument_event.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const body = ddl.slice(ddl.indexOf("filing_registry` ("));
    const ddlCols = [
      ...body.slice(0, body.indexOf("\n)")).matchAll(/^ {2}(\w+)\s+[A-Z]/gm),
    ].map((m) => m[1]);
    assert.equal(ddlCols.length, 22, "the DDL parse found the table");
    const sql = buildMergeSql("`t`", "`s`");
    const insert = sql
      .slice(sql.indexOf("INSERT") + "INSERT".length, sql.indexOf("VALUES"))
      .replace(/[()\s]/g, "")
      .split(",");
    assert.deepEqual(insert, ddlCols);
  });
});

describe("MONEY-1533 — the dry run", () => {
  it("walks and prices without a statement or an object", async () => {
    const rows = walk(7, 3);
    const r = await syncFilingRegistry({
      ...BASE,
      pages: pagesOf(rows),
      io: null,
      stageRows: 4,
    });
    assert.equal(r.rows, 7);
    assert.equal(r.objects, 2);
    assert.equal(r.merge, null);
    const expected = rows
      .flat()
      .reduce((n, x, i) => n + logicalBytes({ stage_seq: i, ...x }), 0);
    assert.equal(r.stagedBytes, expected);
  });
});

describe("logicalBytes — BigQuery's documented data sizes", () => {
  it("STRING 2+utf8, INT64 8, BOOL 1, NULL 0, ARRAY and row the sum", () => {
    assert.equal(logicalBytes("abc"), 5);
    assert.equal(logicalBytes("é"), 4); // two UTF-8 bytes
    assert.equal(logicalBytes(18_765_482), 8);
    assert.equal(logicalBytes(false), 1);
    assert.equal(logicalBytes(null), 0);
    assert.equal(logicalBytes([]), 0);
    assert.equal(logicalBytes(["2.02", "9.01"]), 12);
    assert.equal(logicalBytes({ a: "x", n: 1, b: true, z: null }), 3 + 8 + 1);
  });
});
