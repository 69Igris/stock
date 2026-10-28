/**
 * `bashArrayBody` — MONEY-1405.
 *
 * The helper exists because a naive `indexOf(")")` truncated
 * `OLD_SCHEDULER_PREFIXES` at a paren inside a COMMENT, and the test that
 * sliced it then reported a retired scheduler as still live. That is a parser,
 * it is load-bearing for three retirement assertions, and it gets its own
 * cases rather than being trusted because those three are green.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bashArrayBody } from "./_bash-array";

const SCHED = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "..", "scripts", "ops", "setup-scheduler.sh"),
  "utf8",
);

describe("bashArrayBody — a comment cannot close an array", () => {
  it("[meta] the real script loaded and holds both arrays", () => {
    assert.ok(SCHED.length > 5000, `setup-scheduler.sh did not load (${SCHED.length}B)`);
    assert.ok(SCHED.includes("OLD_SCHEDULER_PREFIXES=("));
    assert.ok(SCHED.includes("PROD_ONLY_JOBS=("));
  });

  it("THE REGRESSION: a `)` inside a comment does not truncate the body", () => {
    // MONEY-1404's comment mentions `(mf.captnemo.in/kuvera)`. Under the old
    // `indexOf(")")` the slice ended there — twelve lines above the element
    // this asserts. MUTATION: slice to the first ")" -> RED.
    const body = bashArrayBody(SCHED, "OLD_SCHEDULER_PREFIXES");
    assert.ok(
      SCHED.includes("mf.captnemo.in/kuvera)"),
      "premise: the script must still carry the parenthesised comment, or " +
        "this case is testing nothing",
    );
    assert.match(body, /"financial-data-sync-weekly"/);
    assert.match(body, /"etf-expense-enrichment-weekly"/);
  });

  it("a name mentioned only in a COMMENT is not an element", () => {
    // MUTATION: stop stripping `#...` -> RED. Without this an array could
    // satisfy its own test by naming the job in prose while never listing it.
    const src = ['X=(', '  # "ghost-job" was retired here', '  "real-job"', ')'].join("\n");
    const body = bashArrayBody(src, "X");
    assert.match(body, /"real-job"/);
    assert.doesNotMatch(body, /ghost-job/);
  });

  it("stops at the array's own close, not a later one", () => {
    const src = ['A=(', '  "a1"', ')', 'B=(', '  "b1"', ')'].join("\n");
    assert.match(bashArrayBody(src, "A"), /"a1"/);
    assert.doesNotMatch(bashArrayBody(src, "A"), /"b1"/);
  });

  it("a quoted `)` in an element does not close it either", () => {
    const src = ['X=(', '  "weird-)-name"', '  "after"', ')'].join("\n");
    assert.match(bashArrayBody(src, "X"), /"after"/);
  });

  it("THROWS rather than returning an empty slice", () => {
    // An empty string makes every `assert.match` against it fail loudly, but an
    // empty string from a RENAMED array makes `assert.doesNotMatch` pass
    // vacuously. Throwing is the only answer that cannot be read as a result.
    assert.throws(() => bashArrayBody(SCHED, "NO_SUCH_ARRAY"), /no array named/);
    assert.throws(() => bashArrayBody('X=(\n  "a"\n', "X"), /never closed/);
  });
});
