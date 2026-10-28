/**
 * `market-data-smoke.sh`'s Cache-Control literals must match what the service
 * emits — and each one must be on an arm with the right VERDICT. MONEY-1475.
 *
 * ## WHY IT LIVES HERE AND NOT IN packages/core
 *
 * The script carries FIVE Cache-Control literals and four of them come from
 * `CACHE_CONTROL` in this app. `packages/core` cannot import `apps/market-data`,
 * so a guard placed there is architecturally incapable of covering them; this
 * workspace can import both, so one loop covers all five.
 *
 * ## WHY IT SLICES THE `case` ARMS RATHER THAN GREPPING THE FILE
 *
 * The first cut asserted `SMOKE.includes('"' + value + '"')` — that a byte
 * sequence appears SOMEWHERE in a 26 KB shell file, comments included. Three
 * reviewers independently mutation-proved that vacuous:
 *
 *   - flipping both healthy `ok` arms to `bad`, so the script FAILS a healthy
 *     service, left it green;
 *   - DELETING the whole `case … esac` and leaving the literals in a `# TODO:`
 *     comment left it green;
 *   - re-spelling the patterns with single quotes — valid shell, identical
 *     behaviour — turned it RED, the opposite of the truth.
 *
 * A source scan cannot assert a policy. So this parses the arms and checks the
 * VERDICT each value is wired to, which is the thing that actually matters.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { cdnCacheControlForHistory } from "@usemoney/core/market-data/udf/history-cache-logic";

import { CACHE_CONTROL } from "../src/app-logic";

const REPO = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const SMOKE = readFileSync(
  join(REPO, "scripts", "ops", "market-data-smoke.sh"),
  "utf8",
);

/**
 * The `/udf/history` grading block: the clock-derived expectations and the arms.
 *
 * The script derives WHICH value it expects from the IST wall clock
 * (`WANT_TTL`) and then matches the header against it, so the TTL literals live
 * in those assignments rather than in the `case` patterns. Both halves have to
 * be read to know what the script actually accepts.
 *
 * `fetch_head` lowercases the WHOLE response, so the script compares lowercased
 * values. Everything here is lowercased to match — otherwise a legal mixed-case
 * directive (RFC 9110: directive names are case-insensitive) would make this
 * demand a literal the script could never match, which is the permanently-red
 * check this ticket exists to end, rebuilt inside the guard against it.
 */
function wantedTtls(): string[] {
  return [...SMOKE.matchAll(/WANT_TTL="([^"]+)"/g)].map((m) =>
    m[1]!.toLowerCase(),
  );
}

function historyArms(): { pattern: string; verdict: string }[] {
  const block = /case "\$HCC_N" in([\s\S]*?)\n\s*esac/.exec(SMOKE);
  assert.ok(block, "the /udf/history case block was not found — did it move?");
  const arms: { pattern: string; verdict: string }[] = [];
  for (const m of block[1]!.matchAll(/^\s*([^)\n]+)\)\s*\n?\s*(ok|bad)\b/gm)) {
    arms.push({ pattern: m[1]!.trim().toLowerCase(), verdict: m[2]! });
  }
  assert.ok(arms.length >= 4, `expected >=4 arms, parsed ${arms.length}`);
  return arms;
}

describe("the smoke script grades /udf/history's cache header correctly", () => {
  it("both CDN values are what the script expects, derived from the function", () => {
    // Never re-spelled here. If the policy changes, this fails on the script
    // that was not updated with it.
    const wanted = wantedTtls();
    for (const inMarket of [true, false]) {
      const ttl = /s-maxage=\d+/.exec(cdnCacheControlForHistory(inMarket))![0];
      assert.ok(
        wanted.includes(ttl),
        `the script never expects '${ttl}' (it expects ${wanted.join(", ")}) ` +
          `— a healthy service in that session would FAIL`,
      );
    }
    assert.equal(wanted.length, 2, "one expectation per session state");
    assert.notEqual(wanted[0], wanted[1], "the two states must differ");
  });

  it("the matching arm is `ok` and the MISMATCH arm is `bad`", () => {
    // The polarity, which a grep for the literals cannot see. A mutation that
    // flips these to `bad`/`ok` makes the script fail a healthy service, or
    // pass a still-forming bar pinned at the edge for an hour.
    const arms = historyArms();
    const match = arms.find((a) => a.pattern.includes("want_ttl"));
    assert.ok(match, "no arm matches the clock-derived expectation");
    assert.equal(match.verdict, "ok");

    const mismatch = arms.find(
      (a) => a.pattern.includes("s-maxage=") && !a.pattern.includes("want_ttl"),
    );
    assert.ok(mismatch, "a CDN value that is the WRONG one must be caught");
    assert.equal(
      mismatch.verdict,
      "bad",
      "accepting both TTLs unconditionally cannot detect an inverted session",
    );
  });

  it("`no-store` lands on a `bad` arm — it now means the chart is BLANK", () => {
    // Since MONEY-1475 the route emits a CDN value only when it HAS BARS, so
    // `no-store` on this probe means no_data or an error. That is the
    // platform-wide state an unconfigured tile store produces for every symbol,
    // and nothing else in the script goes red for it.
    const arm = historyArms().find((a) => a.pattern.includes("no-store"));
    assert.ok(arm, "no-store must be handled explicitly, not by the catch-all");
    assert.equal(arm.verdict, "bad", "no-store must be reported as a fault");
  });

  it("there is a catch-all arm, so an unrecognised value cannot pass silently", () => {
    const arms = historyArms();
    const last = arms[arms.length - 1]!;
    assert.equal(last.pattern, "*", "the final arm must be the `*)` catch-all");
    assert.equal(last.verdict, "bad");
  });

  it("the header is normalised before matching, so OWS cannot fail a healthy service", () => {
    // RFC 9111 makes Cache-Control an unordered directive set and RFC 9110
    // permits optional whitespace, so `public,s-maxage=60,...` and a tab after
    // the colon are the SAME policy. Byte-exact matching sent five legal
    // spellings to the failing catch-all.
    assert.match(SMOKE, /HCC_N=.*tr -d/, "whitespace must be stripped");
    assert.match(SMOKE, /HCC_N=.*sort/, "directive order must be normalised");
  });
});

describe("every other Cache-Control literal in the script matches the service", () => {
  it("config, time and health are the values this app actually emits", () => {
    // The four that come from CACHE_CONTROL. `notImplemented` is deliberately
    // NOT asserted against a script literal: the script never probes an error
    // path, and pinning a value nothing checks is how a dead assertion is born.
    for (const [name, value] of [
      ["config", CACHE_CONTROL.config],
      ["time", CACHE_CONTROL.time],
      ["health", CACHE_CONTROL.health],
    ] as const) {
      assert.ok(
        SMOKE.includes(`"${value.toLowerCase()}"`),
        `market-data-smoke.sh does not carry CACHE_CONTROL.${name} ` +
          `('${value}') — the service emits it, so the check would FAIL on a ` +
          `healthy service`,
      );
    }
  });

  it("noData is `no-store` and is SEPARATE from notImplemented", () => {
    // Identical values, different facts: one is "we hold no bars for this
    // window", the other is "this path is not implemented". A change to one
    // must not silently move the other.
    assert.equal(CACHE_CONTROL.noData, "no-store");
    assert.equal(CACHE_CONTROL.notImplemented, "no-store");
    assert.notEqual(
      Object.keys(CACHE_CONTROL).indexOf("noData"),
      Object.keys(CACHE_CONTROL).indexOf("notImplemented"),
      "they must be two entries, not an alias",
    );
  });

  it("no CDN value is emitted for a body with no bars", () => {
    // The defect this ticket found in the ROUTE, asserted as a property: a
    // `no_data` must never carry a shared-cache TTL, or a blank chart outlives
    // the tile write that fixes it.
    assert.doesNotMatch(CACHE_CONTROL.noData, /s-maxage|max-age=[1-9]/);
    assert.match(CACHE_CONTROL.noData, /no-store/);
  });
});
