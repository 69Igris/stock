/**
 * MONEY-1274 — the anchored-report read must be scoped to its owner.
 *
 * `assembleAnchorContext` loads a research report named by `pagePath`, and
 * `pagePath` arrives in the REQUEST BODY. It is not derived from the session,
 * not validated by routing, and entirely under the caller's control — so
 * `/analysis/<someone-elses-session-id>` is a string anyone can send.
 *
 * Without a `userId` in the WHERE clause that is an IDOR whose payload lands in
 * the MODEL'S CONTEXT, and therefore in the reply text: another user's research
 * question, the symbols they are looking at, and the report's findings, read
 * back to the attacker in prose. A `findUnique({ where: { sessionId } })` would
 * look completely ordinary and be exactly that bug.
 *
 * ## Why a source scan
 *
 * The seam is a Prisma call. Driving it needs a database and two users, and a
 * hand-rolled fake would only prove things about the fake — the repo forbids
 * shadow tests for precisely this reason. What CAN be pinned is that the
 * ownership filter is present in the query itself, and that the read is a
 * `findFirst` on a compound WHERE rather than a `findUnique` on the id alone.
 *
 * Source under test: apps/web/lib/gemini/anchor-context.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAW = readFileSync(
  join(process.cwd(), "lib/gemini/anchor-context.ts"),
  "utf8"
);

/**
 * Comments stripped.
 *
 * The doc comment on the source EXPLAINS the unsafe shape it avoids — it names
 * `findUnique` and `userId` in prose. Scanning the raw file therefore matched
 * the explanation rather than the code, and the "does not use findUnique" case
 * failed against a file that does not use it. A scan test has to assert over
 * SYNTAX; matching prose makes documenting a hazard indistinguishable from
 * committing it.
 */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("assembleAnchorContext — ownership", () => {
  it("[security] every session read carries userId in the WHERE", () => {
    // Both tables are reachable from one path (`/analysis/<id>` serves
    // ResearchSession AND AnalysisSession, split by id prefix), so BOTH reads
    // need the filter — covering one and missing the other leaks half the time.
    const wheres = [...SRC.matchAll(/where:\s*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(wheres.length >= 2, "expected a read per session table");
    for (const w of wheres) {
      assert.match(
        w,
        /\buserId\b/,
        `a session read is not scoped by userId — that is an IDOR into the ` +
          `model's context. WHERE was: {${w.trim()}}`
      );
      assert.match(w, /\bsessionId\b/);
    }
  });

  it("[security] does not read by id alone via findUnique", () => {
    // `sessionId` is @unique, so findUnique on it compiles and works — and
    // silently drops the ownership condition. findFirst with a compound where
    // is the shape that cannot express the unsafe query by accident.
    assert.doesNotMatch(
      SRC,
      /\.findUnique\s*\(/,
      "findUnique on the unique sessionId cannot carry the userId filter"
    );
    assert.match(SRC, /\.findFirst\s*\(/);
  });

  it("[security] bails out when there is no userId to scope by", () => {
    // An empty userId must not become an unfiltered read.
    assert.match(SRC, /if\s*\(\s*!userId\s*\)\s*return\s*""/);
  });

  it("never throws — chat must survive this block failing", () => {
    // Same contract as assembleUserContext. A context enhancement that can
    // take down the chat is a worse trade than not having it.
    assert.match(SRC, /catch\s*\{[\s\S]*?return\s*""/);
  });

  it("only the research anchor triggers a read", () => {
    // A stock or screener anchor is fully described by its path; fetching
    // company figures here would duplicate the tools rather than ground the
    // answer in something the user can actually see on screen.
    assert.match(SRC, /anchor\.kind\s*!==\s*"research"/);
  });

  it("the id-prefix discriminator matches the client's routing", () => {
    // `/analysis/<id>` serves two tables and the client picks by prefix via
    // isAnalysisSessionId. If these drift, this module reads the WRONG table
    // and silently returns nothing for a report that exists.
    const routing = readFileSync(
      join(process.cwd(), "lib/analysis/session-routing.ts"),
      "utf8"
    );
    for (const prefix of ["l3-", "l4-"]) {
      assert.ok(
        SRC.includes(`"${prefix}"`),
        `anchor-context is missing the ${prefix} prefix`
      );
      assert.ok(
        routing.includes(`"${prefix}"`),
        `session-routing no longer declares ${prefix} — the two have drifted`
      );
    }
  });
});
