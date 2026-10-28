/**
 * The DDL applier's parsing — MONEY-1472 (B1).
 *
 * Both failures here are silent in a way a SQL error is not: a statement cut in
 * half by a naive split fails with a parse error pointing at the wrong place,
 * and an unsubstituted placeholder RUNS and creates a table literally named
 * `{{DATASET}}.source_object`, which every later loader then misses.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDdl, splitStatements } from "../src/ddl";

const HERE = dirname(fileURLToPath(import.meta.url));
const DDL = readFileSync(
  join(HERE, "..", "ddl", "001_bronze_ledger.sql"),
  "utf8",
);

describe("the splitter respects quotes", () => {
  it("a `;` inside a description does NOT end the statement", () => {
    // THE DEFECT THIS EXISTS FOR. The first cut forbade a semicolon inside a
    // string literal and threw — and the very first DDL file tripped it FIVE
    // times, because `OPTIONS(description = "...")` is prose and prose has
    // semicolons in it. Forbidding punctuation in a comment field is a trap set
    // for whoever writes the next migration.
    const sql = `CREATE TABLE a (x INT64 OPTIONS(description = "one; two"));
                 CREATE TABLE b (y INT64);`;
    const parts = splitStatements(sql);
    assert.equal(parts.length, 2, "the description's `;` must not split it");
    assert.match(parts[0]!, /one; two/);
  });

  it("single quotes and backtick identifiers count too", () => {
    const sql = "CREATE TABLE `a;b` (x STRING DEFAULT 'p;q'); SELECT 1;";
    const parts = splitStatements(sql);
    assert.equal(parts.length, 2);
    assert.match(parts[0]!, /`a;b`/);
  });

  it("a backslash escape does not end the string early", () => {
    const sql = 'SELECT "he said \\"; done\\""; SELECT 2;';
    assert.equal(splitStatements(sql).length, 2);
  });

  it("comment lines are dropped, including ones holding a `;`", () => {
    const sql = `-- a comment; with a semicolon
                 CREATE TABLE a (x INT64);`;
    const parts = splitStatements(sql);
    assert.equal(parts.length, 1);
    assert.ok(!parts[0]!.includes("a comment"));
  });

  it("an UNTERMINATED literal throws rather than running a fragment", () => {
    // Running the fragment produces a parse error pointing at the wrong place,
    // which costs an hour to diagnose.
    assert.throws(
      () => splitStatements('CREATE TABLE a (x STRING DEFAULT "oops'),
      /unterminated/,
    );
  });

  it("a trailing statement with no final `;` is not dropped", () => {
    assert.equal(splitStatements("SELECT 1; SELECT 2").length, 2);
  });
});

describe("rendering refuses to leave a placeholder behind", () => {
  it("substitutes the dataset", () => {
    assert.match(
      renderDdl("CREATE TABLE `{{DATASET}}.x` ()", "lake_bronze_qa"),
      /lake_bronze_qa\.x/,
    );
  });

  it("an UNKNOWN placeholder throws", () => {
    // It would otherwise create a table literally named `{{ENV}}` — a schema
    // that exists, answers queries, and is invisible to every later loader.
    assert.throws(
      () =>
        renderDdl("CREATE TABLE `{{DATASET}}.{{ENV}}` ()", "lake_bronze_qa"),
      /unsubstituted placeholder/,
    );
  });
});

describe("the real DDL file parses into the four ledger tables", () => {
  it("four statements, one per table the contract names", () => {
    // `lake-layout.md` says lake_bronze holds exactly these four. A fifth table
    // appearing here without the doc changing is the drift that
    // lake-infra-coverage.test.ts exists to catch one layer up.
    const parts = splitStatements(renderDdl(DDL, "lake_bronze_qa"));
    assert.equal(parts.length, 4);
    for (const t of [
      "source_object",
      "pipeline_run",
      "partition_load",
      "quarantine",
    ]) {
      assert.ok(
        parts.some((p) => p.includes(`lake_bronze_qa.${t}\``)),
        `no CREATE for ${t}`,
      );
    }
  });

  it("every statement is IF NOT EXISTS — a re-run must be a no-op", () => {
    // The applier does not read the current schema and diff it; idempotency is
    // a property of the SQL, so a statement without the guard would fail the
    // second time this is applied to an environment.
    for (const p of splitStatements(renderDdl(DDL, "lake_bronze_qa"))) {
      assert.match(p, /CREATE TABLE IF NOT EXISTS|ADD COLUMN IF NOT EXISTS/);
    }
  });

  it("partition_load carries all five key columns", () => {
    // The five-part identity is unique BY CONVENTION — BigQuery enforces no
    // key — so a column missing from the table makes every MERGE match too
    // broadly and silently collapse distinct partitions.
    const stmt = splitStatements(renderDdl(DDL, "lake_bronze_qa")).find((p) =>
      p.includes("partition_load"),
    )!;
    for (const col of [
      "dataset",
      "`table`",
      "partition_key",
      "source_hash",
      "parser_version",
    ]) {
      assert.ok(stmt.includes(col), `partition_load is missing ${col}`);
    }
  });

  it("money is NUMERIC, never FLOAT64", () => {
    const stmt = splitStatements(renderDdl(DDL, "lake_bronze_qa")).find((p) =>
      p.includes("source_object"),
    )!;
    assert.match(
      stmt,
      /cost_usd\s+NUMERIC/,
      "binary rounding must not reach a cost",
    );
  });
});

describe("005 instrument_current — listed_since is the listing's FIRST valid_from (MONEY-1602)", () => {
  // The view's own SELECT, run in node:sqlite over prod-shaped rows. A
  // backticked `s.listing` is ONE identifier in SQLite, so the rendered text
  // runs unchanged once the BigQuery-only `CREATE OR REPLACE VIEW` head is cut.
  const [stmt, ...rest] = splitStatements(
    renderDdl(
      readFileSync(
        join(HERE, "..", "ddl", "005_gold_instrument_current.sql"),
        "utf8",
      ),
      { DATASET: "g", SILVER: "s" },
    ),
  );

  it("is ONE statement and a CREATE OR REPLACE — a re-apply replaces it with itself", () => {
    assert.equal(rest.length, 0);
    assert.match(stmt!, /^CREATE OR REPLACE VIEW `g\.instrument_current` AS/);
  });

  it("a delisted listing reports its listing date, once, on its open DELISTED row", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const cols = [
      "listing_id",
      "market",
      "venue",
      "symbol",
      "isin",
      "name",
      "asset_type",
      "currency",
      "status",
      "valid_from",
      "valid_to",
      "perma_ticker",
      "cik10",
      "cusip",
      "sector",
      "industry",
      "source",
      "observed_at",
      "ingested_at",
    ];
    db.exec(`CREATE TABLE \`s.listing\` (${cols.join(", ")})`);
    const insert = db.prepare(
      `INSERT INTO \`s.listing\` (listing_id, status, valid_from, valid_to) VALUES (?, ?, ?, ?)`,
    );
    // Dow Chemical as identity/2 writes it, and Dow Inc. still open.
    insert.run("DOW:NYSE:1972-06-01", "ACTIVE", "1972-06-01", "2017-09-01");
    insert.run("DOW:NYSE:1972-06-01", "DELISTED", "2017-09-01", null);
    insert.run("DOW:NYSE:2019-03-20", "ACTIVE", "2019-03-20", null);

    const select = stmt!.replace(/^CREATE OR REPLACE VIEW [^\n]* AS\n/, "");
    const rows = db.prepare(`${select} ORDER BY listing_id`).all() as {
      listing_id: string;
      status: string;
      listed_since: string;
    }[];
    assert.deepEqual(
      rows.map((r) => [r.listing_id, r.status, r.listed_since]),
      [
        ["DOW:NYSE:1972-06-01", "DELISTED", "1972-06-01"],
        ["DOW:NYSE:2019-03-20", "ACTIVE", "2019-03-20"],
      ],
    );
  });
});
