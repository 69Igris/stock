/**
 * `sync-prod-to-qa` must re-link EVERY required-relation collection —
 * MONEY-1216, generalised in MONEY-1220, made ACTUALLY RUNNABLE in MONEY-1238.
 *
 * ## The coupling this exists to keep
 *
 * `instrument_mappings` is QA-DIRECT: QA mints its own ObjectIds and the sync
 * never overwrites them. Every REFERENCE collection is copied from prod
 * carrying PROD's `instrumentId`, so after each restore those ids exist only in
 * prod.
 *
 * For an OPTIONAL relation that is cosmetic — readers join on symbol and the
 * dangling id is never dereferenced. The sync script says so, and for those it
 * is right.
 *
 * For a REQUIRED relation Prisma does not return null. It THROWS, and the throw
 * kills the whole query, so ONE orphaned row takes out every result the caller
 * asked for. That is how QA's screener rendered every fundamental column as `-`
 * with no visible error (MONEY-1216).
 *
 * ## Why the list is DERIVED and not written down
 *
 * MONEY-1216 fixed `stock_ratios` and closed with: "any future collection added
 * to REFERENCE_COLLECTIONS that carries a required relation has this same
 * defect." Four already did — `stock_documents`, `stock_financials`,
 * `stock_peers`, `stock_shareholding` — and nobody noticed, because a note in a
 * ticket cannot fail a build.
 *
 * So this test READS `schema.prisma` and computes the set itself, then holds
 * BOTH implementations to it: the mongosh program the sync script runs on every
 * scheduled restore, and `repair-instrument-links.ts`, the by-hand remedy. A
 * hardcoded list would have exactly the same shelf life as the note.
 *
 * ## What MONEY-1238 added, and why the old assertions were not enough
 *
 * Every check here used to be "does this string appear". Three behaviours the
 * file NAMED were false the whole time it was green:
 *
 *   - the re-link was gated on `[ ${#FAILED[@]} -eq 0 ]`, so ONE unrelated
 *     collection failing skipped the repair for the five that had just been
 *     replaced with prod's rows;
 *   - the re-link ran `npx tsx`, and the image has no Node and never carried
 *     the .ts — so it could not execute at all, ever;
 *   - the script had no `exit` after the restore loop, so it fell off the end
 *     and the Cloud Run job reported SUCCEEDED over all of it.
 *
 * The old "a failed re-link fails the run" test asserted only that the string
 * `FAILED+=` occurred near the invocation. It passed against a script that
 * exited 0 no matter what. Assertions below are on DECISIONS: which condition
 * gates the call, which runtime the call needs, and whether preflight checks
 * that runtime. The exit CODE itself is proven by running the script —
 * `sync-prod-to-qa-exit-code.spawntest.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const SYNC = read("scripts/ops/sync-prod-to-qa.sh");
const SCHEMA = read("packages/database/prisma/schema.prisma");
const REPAIR = read("scripts/ops/repair-instrument-links.ts");
const DOCKERFILE = read("scripts/ops/sync-job/Dockerfile");

/**
 * ── COMMENT STRIPPING: why every CODE assertion in this file goes through it ──
 *
 * Every assertion here reads a file as text, so any of them can be satisfied by
 * a line of PROSE that merely mentions the thing. That is not hypothetical
 * here: this file, the sync script and the Dockerfile all DESCRIBE, at length,
 * the broken code MONEY-1238 removed — `npx tsx repair-instrument-links.ts`,
 * `if [ ${#FAILED[@]} -eq 0 ]`, `FAILED+=` — because the next reader needs to
 * know what was wrong with it. Against the raw text a `match` can therefore
 * pass over a script that does none of it, and a `doesNotMatch` can fail over a
 * script that is entirely correct. This ticket exists because two tests passed
 * while the behaviour they named was false; asserting on prose is how that
 * happens.
 *
 * So: assertions about CODE read a `*_CODE` view. The handful that deliberately
 * assert an explanatory COMMENT still exists read the raw text and say so at
 * the call site. `it("the comment strippers are live", …)` at the bottom keeps
 * the strippers from quietly degrading into identity functions, which would
 * turn every one of those assertions back into a shadow test without changing
 * a single line of the assertion itself.
 *
 * ORDER IS LOAD-BEARING for C-style sources: LINE comments first, THEN block
 * comments. Reversed, a commented-out block-OPENER survives the block pass (it
 * has no terminator yet) and the line pass is already over — the stray
 * delimiter then swallows real code up to the next terminator (MONEY-1143).
 */
const stripTsComments = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Drop WHOLE-LINE `#` comments. Shell and Dockerfile have no block comments, so
 * one pass is the whole job.
 *
 * Whole-line ONLY, and that restriction is load-bearing rather than lazy: a
 * naive `s/#.*$//` would cut `if [ ${#FAILED[@]} -gt 0 ]` — the exit gate this
 * ticket added — down to `if [ ${`, and the gating assertion below is a
 * `doesNotMatch`, so mangling the input would make it pass vacuously. A `#`
 * inside `${#ARRAY[@]}` or a quoted string is CODE and stays.
 */
const stripHashComments = (src: string): string =>
  src.replace(/^[^\S\r\n]*#.*$/gm, "");

/** Prisma: `//` and `///` line comments, no block comments. */
const stripPrismaComments = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "");

const REPAIR_CODE = stripTsComments(REPAIR);
const SYNC_CODE = stripHashComments(SYNC);
const DOCKERFILE_CODE = stripHashComments(DOCKERFILE);
const SCHEMA_CODE = stripPrismaComments(SCHEMA);

/**
 * Names inside a `NAME=( … )` bash array literal — read from SYNC_CODE, so a
 * collection that has been COMMENTED OUT of the allowlist counts as absent.
 */
function bashArray(name: string): Set<string> {
  const at = SYNC_CODE.indexOf(`${name}=(`);
  assert.ok(at > 0, `${name} not found in sync-prod-to-qa.sh`);
  const block = SYNC_CODE.slice(at, SYNC_CODE.indexOf("\n)", at));
  return new Set([...block.matchAll(/^\s*"([a-z_]+)"/gm)].map((m) => m[1]!));
}

/** Synced collections whose `instrument` relation is REQUIRED (no `?`). */
function requiredRelationCollections(): string[] {
  const ref = bashArray("REFERENCE_COLLECTIONS");
  const out: string[] = [];
  for (const m of SCHEMA_CODE.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const body = m[2]!;
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1];
    if (!table || !ref.has(table)) continue;
    // `instrument InstrumentMapping` (required) vs `InstrumentMapping?`.
    if (/^\s+instrument\s+InstrumentMapping\s/m.test(body)) out.push(table);
  }
  return out.sort();
}

/**
 * The `mongosh … --file` line the sync script uses to run its re-link, and the
 * heredoc body that line executes.
 *
 * Both are located structurally rather than by a fixed line number so that a
 * rewrite of the block is caught by the assertions rather than by the parser
 * silently finding nothing.
 */
function relinkInvocation(): { line: string; runtime: string } {
  // SYNC_CODE, so a commented-out invocation reads as no invocation at all —
  // and the `echo` filter still matters, because the FAILURE branch echoes the
  // by-hand command as help text and that echo is real code, not a comment.
  const lines = SYNC_CODE.split("\n");
  const idx = lines.findIndex(
    (l) => /--file\s/.test(l) && !l.trimStart().startsWith("echo"),
  );
  assert.ok(idx >= 0, "no line of CODE runs a re-link program via --file");
  const line = lines[idx]!;
  // The runtime is the first bare word that is not a VAR=value prefix or a
  // line-continuation. Derived, not hardcoded: if the re-link is ever moved
  // back onto `npx`, the preflight assertion below must move with it.
  const runtime = line
    .trim()
    .split(/\s+/)
    .find((w) => w !== "\\" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  assert.ok(runtime, `could not read a runtime binary out of: ${line}`);
  return { line, runtime };
}

/**
 * The heredoc body verbatim. Extracted from the RAW script on purpose: inside
 * the heredoc the language is JavaScript, not shell, so a `#` there would be
 * code — `stripHashComments` must not be let anywhere near it.
 */
function relinkProgram(): string {
  const open = SYNC.indexOf("<<'RELINK_JS'");
  assert.ok(open > 0, "the embedded re-link program (<<'RELINK_JS') is gone");
  const start = SYNC.indexOf("\n", open) + 1;
  const end = SYNC.indexOf("\nRELINK_JS\n", start);
  assert.ok(end > start, "the RELINK_JS heredoc is not terminated");
  return SYNC.slice(start, end);
}

/** The same program with its JS comments removed — for CODE assertions. */
function relinkProgramCode(): string {
  return stripTsComments(relinkProgram());
}

describe("sync-prod-to-qa re-links every required-relation collection", () => {
  const required = requiredRelationCollections();

  it("finds the collections at all — a silent empty set proves nothing", () => {
    // If the parser breaks, every assertion below passes vacuously. This is the
    // canary that keeps the suite honest about its own inputs.
    assert.ok(
      required.length >= 5,
      `expected >= 5 required-relation REFERENCE collections, got ${required.length}: ${required.join(", ")}`,
    );
    assert.ok(required.includes("stock_ratios"));
    assert.ok(
      required.includes("stock_financials"),
      "stock_financials is the XBRL projection's target — it must be covered",
    );
  });

  for (const table of required) {
    it(`${table} is in the list the SCHEDULED re-link actually repairs`, () => {
      // RELINK_COLLECTIONS is what the nightly Cloud Run job passes to its
      // mongosh program. This is the assertion that matters operationally: the
      // .ts below is only ever run by hand.
      assert.ok(
        bashArray("RELINK_COLLECTIONS").has(table),
        `${table} is synced from prod with a REQUIRED instrument relation and ` +
          `RELINK_COLLECTIONS does not list it — the nightly sync will restore ` +
          `it with prod's ids and leave every QA query selecting that relation ` +
          `throwing`,
      );
    });

    it(`${table} is covered by the by-hand repair script`, () => {
      assert.match(
        REPAIR_CODE,
        new RegExp(`table:\\s*"${table}"`),
        `${table} is synced from prod with a REQUIRED instrument relation and ` +
          `repair-instrument-links.ts does not cover it — the documented manual ` +
          `remedy would silently leave it orphaned`,
      );
    });
  }

  it("the two implementations cover the SAME set, so neither can drift", () => {
    // There are two on purpose: the scheduled one runs on mongosh because the
    // image has no Node, the by-hand one runs on tsx because a laptop does.
    // Drift between them is the whole risk of having two, so it is pinned.
    const shell = [...bashArray("RELINK_COLLECTIONS")].sort();
    const ts = [...REPAIR_CODE.matchAll(/table:\s*"([a-z_]+)"/g)]
      .map((m) => m[1]!)
      .sort();
    assert.deepEqual(shell, ts);
  });

  it("the sync RUNS its re-link — it does not merely ship one", () => {
    // The INVOCATION line, not any line mentioning the re-link. The failure
    // branch echoes the manual command as help text — an earlier version of
    // this assertion matched that echo and passed with the real call downgraded
    // to --dry-run.
    const { line, runtime } = relinkInvocation();
    assert.match(
      line,
      /"\$QA_TARGET"/,
      "the re-link must be pointed at the QA URL explicitly",
    );
    assert.equal(
      runtime,
      "mongosh",
      "the re-link must run on a binary the image actually has; `npx`/`node` " +
        "are not installed in google/cloud-sdk:slim (MONEY-1238)",
    );
  });

  it("the re-link is NOT gated on a clean run", () => {
    // THE regression this file exists to catch after MONEY-1238. The gate used
    // to be `if [ ${#FAILED[@]} -eq 0 ]`, so one unrelated collection failing
    // skipped the repair for the five that HAD just been replaced by prod's
    // rows — the exact state the repair exists to prevent, reached by bailing
    // out early. A partial restore needs the re-link more than a clean one.
    const at = SYNC_CODE.indexOf('if [ "$RELINK_NEEDED" == "true" ]');
    assert.ok(at > 0, "the re-link is no longer gated on RELINK_NEEDED");

    const loopEnd = SYNC_CODE.indexOf("\n    done\n");
    assert.ok(loopEnd > 0 && loopEnd < at, "restore loop not found before it");
    // SYNC_CODE, not SYNC: the block between those two points deliberately
    // QUOTES the old `if [ ${#FAILED[@]} -eq 0 ]` gate in prose, so that the
    // next reader knows what was wrong with it. Against the raw text this
    // `doesNotMatch` would fail on the EXPLANATION of the fix.
    const between = SYNC_CODE.slice(loopEnd, at);
    assert.doesNotMatch(
      between,
      /^\s*(if|elif)\s+\[\s*\$\{#FAILED\[@\]\}\s*-eq\s*0\s*\]/m,
      "the re-link is gated on zero failures again — a partial restore now " +
        "leaves QA's restored collections pointing at prod's ObjectIds",
    );
    assert.match(
      between,
      /RELINK_NEEDED=true/,
      "RELINK_NEEDED must be computed from what was RESTORED, not from FAILED",
    );
    assert.match(
      between,
      /for R in "\$\{RESTORED\[@\]\}"/,
      "RELINK_NEEDED must be derived from the collections that restored",
    );
  });

  it("a re-link that leaves orphans is a DISTINCT failure from one that errored", () => {
    // They need different actions: `relink` means re-run / check connectivity;
    // `relink-orphans-remain` means this environment is missing instruments.
    // Collapsing them loses the only signal that says which.
    assert.match(SYNC_CODE, /FAILED\+=\("relink"\)/);
    assert.match(SYNC_CODE, /FAILED\+=\("relink-orphans-remain"\)/);
    assert.match(
      SYNC_CODE,
      /elif \[ "\$RELINK_RC" -eq 2 \]/,
      "exit 2 (ran clean, rows still dangling) must be handled on its own",
    );
  });

  it("preflight checks the runtime the re-link needs", () => {
    // Derived from the invocation, so moving the re-link onto another runtime
    // fails here until preflight is moved with it. MONEY-1238: preflight
    // checked mongodump/mongorestore/mongosh/gcloud while the re-link needed
    // `npx`, so a missing runtime surfaced as one yellow line AFTER every
    // collection had already been dropped and replaced.
    const { runtime } = relinkInvocation();
    const at = SYNC_CODE.indexOf("preflight() {");
    assert.ok(at > 0, "preflight() not found");
    const body = SYNC_CODE.slice(at, SYNC_CODE.indexOf("\n}\n", at));
    // SYNC_CODE: preflight's own comment explains that MONEY-1238's re-link ran
    // on a runtime preflight never checked. Read raw, a `command -v mongosh`
    // line commented OUT would still satisfy this.
    assert.ok(
      body.includes(`command -v ${runtime} `),
      `preflight() does not check for \`${runtime}\`, the binary the re-link ` +
        `invokes — a missing runtime would not be caught until after QA's ` +
        `collections had been dropped`,
    );
  });

  it("the embedded re-link program is syntactically valid JavaScript", () => {
    // It is a heredoc inside a shell script, so nothing else in the toolchain
    // reads it: `bash -n` sees an opaque blob and tsc never sees it at all. A
    // typo here would surface as a nightly RE-LINK FAILED and nothing sooner.
    // Compiled, never executed — `db`/`print`/`quit` are mongosh globals.
    assert.doesNotThrow(
      () => new vm.Script(relinkProgram(), { filename: "relink.js" }),
    );
  });

  it("the re-link program fails CLOSED on an empty instrument table", () => {
    // Without this, an environment whose instrument_mappings is empty makes
    // every row look orphaned-and-unrepairable, which prints identically to
    // "nothing to do". Same shape as the empty-guard the restore loop already
    // has, one layer down.
    const js = relinkProgramCode();
    assert.match(js, /alive\.size === 0/);
    assert.match(js, /quit\(1\)/);
  });

  it("the re-link program pages forward on _id rather than buffering the table", () => {
    // The job runs with --memory=1Gi and these collections run to hundreds of
    // thousands of rows. Paging on _id is also what makes it safe to write
    // while scanning: the repair rewrites `instrumentId` and never `_id`, so
    // the pagination key cannot move under the scan.
    const js = relinkProgramCode();
    assert.match(js, /\{ _id: \{ \$gt: lastId \} \}/);
    assert.match(js, /\.sort\(\{ _id: 1 \}\)/);
    assert.match(js, /\.limit\(PAGE\)/);
  });

  it("the re-link program verifies its writes LANDED", () => {
    // Every queued row is an orphan being repointed at a different live id, so
    // each update must modify exactly one document. Reporting the intent
    // instead of the result is how a repair claims to have happened.
    const js = relinkProgramCode();
    assert.match(js, /wrote !== ops\.length/);
  });
});

describe("the image ships what the re-link needs", () => {
  it("installs and verifies the re-link's runtime", () => {
    // MONEY-1238: the re-link ran `npx tsx …repair-instrument-links.ts`, and
    // this Dockerfile COPYs exactly one file onto a base with no Node. Neither
    // the runtime nor the program was ever in the image. mongosh is, and this
    // is what keeps it that way.
    const { runtime } = relinkInvocation();
    // DOCKERFILE_CODE: the header of that file spends twenty lines explaining
    // that mongosh is load-bearing for the re-link. Read raw, deleting the
    // install would leave the prose behind and this assertion green.
    assert.ok(
      DOCKERFILE_CODE.includes(`${runtime} --version`),
      `the sync image does not verify \`${runtime}\` at build time — the ` +
        `re-link would fail at runtime on every scheduled run`,
    );
    assert.match(
      DOCKERFILE_CODE,
      /MONGOSH_VERSION=/,
      "mongosh must stay version-pinned: it is load-bearing for the re-link, " +
        "not just for the empty-guard row count",
    );
  });

  it("COPYs the file the ENTRYPOINT runs", () => {
    // The re-link now lives INSIDE the sync script, so "is the repair in the
    // image" and "is the script in the image" are the same question — and the
    // answer used to be no for the repair. One COPY, one ENTRYPOINT, and they
    // must name the same path; a rename on one side alone produces an image
    // whose only job is to exec a file that is not there.
    const entry = /ENTRYPOINT \["([^"]+)"/.exec(DOCKERFILE_CODE)?.[1];
    assert.ok(entry, "the image has no ENTRYPOINT");
    assert.ok(
      new RegExp(`^COPY\\s+\\S+\\s+${entry}\\s*$`, "m").test(DOCKERFILE_CODE),
      `nothing COPYs ${entry} into the image — the ENTRYPOINT would exec a ` +
        `path that does not exist, and the embedded re-link with it`,
    );
  });

  it("does not reach for a program the image cannot carry", () => {
    // The script COPYd into the image must not shell out to a sibling file:
    // there is exactly one COPY, and a repair in a second file is a repair that
    // can be left out of it. That is precisely how MONEY-1238 happened.
    const { line } = relinkInvocation();
    assert.doesNotMatch(
      line,
      /repair-instrument-links|npx|tsx|\bnode\b/,
      "the scheduled re-link points at a program/runtime the sync image does " +
        "not contain",
    );
  });
});

describe("the repair runs against QA, and only QA", () => {
  it("refuses a non-QA DATABASE_URL", () => {
    // Direction is the whole risk. Pointed at prod this rewrites PROD's
    // instrument ids from QA's — worse than the bug and unrecoverable without a
    // restore.
    assert.match(REPAIR_CODE, /REFUSING TO RUN/);
    assert.match(REPAIR_CODE, /!\/qa\/i\.test\(url\)/);
  });

  it("is a positive test for QA, not a negative test for prod", () => {
    // A `!/prod/` check would let any newly-named environment sail through. The
    // guard must fail CLOSED on an unfamiliar name.
    // REPAIR_CODE for the same reason the gating check above uses SYNC_CODE:
    // the guard's own comment says it is "a positive test for QA rather than a
    // negative one for prod", and a `doesNotMatch` on raw text would one day
    // fail on that sentence rather than on a real regression.
    assert.doesNotMatch(REPAIR_CODE, /\/prod\/i?\.test\(url\)/);
  });

  it("writes nothing without --apply", () => {
    assert.match(
      REPAIR_CODE,
      /const APPLY = process\.argv\.includes\("--apply"\)/,
    );
    assert.match(REPAIR_CODE, /if \(APPLY\) \{\s*await model\.update/);
  });

  it("counts unmatched rows instead of guessing at a near match", () => {
    // Pointing an orphan at a nearby symbol would silently attribute one
    // company's financials to another — worse than leaving it orphaned.
    assert.match(REPAIR_CODE, /unmatched\+\+/);
    // RAW on purpose, and the only assertion in this file that is: the reason
    // an unmatched row must not be repointed at a near match cannot be read off
    // the code (`unmatched++` looks like an oversight), so the comment carrying
    // it is the artefact being pinned. Stripped, this would assert nothing.
    assert.match(REPAIR, /never guessed at/);
  });

  it("the sync refuses to run when both secrets resolve to one database", () => {
    // The sync's own direction lock is structural — the target is whatever
    // DATABASE_URL_QA holds — so the one way it fails is at the SECRET. Checked
    // by identity, not by looking for "qa" in the string, so it cannot refuse a
    // correctly-configured run.
    assert.match(SYNC_CODE, /if \[ "\$PROD_URL" == "\$QA_URL" \]/);
    assert.match(
      SYNC_CODE,
      /REFUSING TO RUN: DATABASE_URL_PROD and DATABASE_URL_QA/,
    );
  });
});

describe("the comment strippers are live", () => {
  // Every CODE assertion above is only as good as the view it reads. If a
  // stripper silently became an identity function — a regex typo, a refactor
  // that forgets a call site — all of them would quietly revert to matching
  // prose, and NOT ONE of them would go red. That is precisely the shape of the
  // defect this ticket is about: green tests over false behaviour. So the views
  // themselves get asserted.

  it("actually remove comments", () => {
    assert.ok(
      SYNC_CODE.length < SYNC.length,
      "stripHashComments removed nothing from a script that is half comments",
    );
    assert.ok(REPAIR_CODE.length < REPAIR.length);
    assert.ok(DOCKERFILE_CODE.length < DOCKERFILE.length);
    assert.ok(SCHEMA_CODE.length < SCHEMA.length);
  });

  it("remove the OLD gate's prose while leaving the NEW gate's code", () => {
    // The sharpest available proof that the distinction is real and load-
    // bearing, using the two live examples in this very script:
    //
    //   `${#FAILED[@]} -eq 0` inside the re-link block exists ONLY in the
    //   comment that explains what was wrong with it — so raw text contains it
    //   and code must not;
    //
    //   `${#FAILED[@]} -gt 0` is the exit gate MONEY-1238 added — a `#` in the
    //   MIDDLE of a line of code, which a naive `s/#.*$//` would have eaten,
    //   taking the gating `doesNotMatch` above down to vacuously true with it.
    const block = SYNC.slice(
      SYNC.indexOf("\n    done\n"),
      SYNC.indexOf('if [ "$RELINK_NEEDED" == "true" ]'),
    );
    assert.match(
      block,
      /\$\{#FAILED\[@\]\} -eq 0/,
      "the script no longer explains the gate it replaced — if that prose was " +
        "deliberately deleted, delete this canary too; do not delete the " +
        "stripping",
    );
    assert.doesNotMatch(
      stripHashComments(block),
      /\$\{#FAILED\[@\]\} -eq 0/,
      "stripHashComments left comment text behind — every CODE assertion in " +
        "this file is now a shadow test",
    );
    assert.match(
      SYNC_CODE,
      /if \[ \$\{#FAILED\[@\]\} -gt 0 \]/,
      "stripHashComments ate a mid-line `#` and destroyed the exit gate",
    );
  });

  it("strip LINE comments before BLOCK comments", () => {
    // MONEY-1143, as an executable statement rather than a note. Reversed, the
    // commented-out opener below survives the block pass (it has no terminator
    // of its own), and the line pass has already run — so the stray delimiter
    // swallows everything up to the next terminator, taking `KEEP` with it.
    const src = [
      "// /*",
      "const KEEP = 1;",
      "/* real block */",
      "const B = 2;",
    ].join("\n");
    const out = stripTsComments(src);
    assert.match(out, /const KEEP = 1;/);
    assert.match(out, /const B = 2;/);
    assert.doesNotMatch(out, /real block/);
  });

  it("keep a `#` that is inside a line of code", () => {
    const src = [
      'echo "a # b"   # trailing note',
      "# whole line",
      "code=1",
    ].join("\n");
    const out = stripHashComments(src);
    assert.match(out, /echo "a # b"/);
    assert.doesNotMatch(out, /whole line/);
    assert.match(out, /code=1/);
  });
});
