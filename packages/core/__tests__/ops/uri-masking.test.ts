/**
 * No ops script may mask a connection string with a ONE-SCHEME pattern —
 * MONEY-1494.
 *
 * ## The defect, which shipped three times
 *
 *     sed 's|mongodb+srv://[^@]*@|mongodb+srv://***@|'
 *
 * matches Atlas and nothing else. PROD is Atlas, so it masked correctly in
 * every review anyone ever read. QA is self-hosted on a GCE address and its URI
 * is plain `mongodb://` — the pattern misses, and sed prints the input
 * UNCHANGED, so the password goes to stdout.
 *
 * It ran on `sync-prod-to-qa.sh`'s normal path (the "Target (qa)" line), which
 * the scheduled Cloud Run job executes, so QA's credentials went into Cloud
 * Logging — retained and indexed — on every sync since MONEY-840.
 *
 * ## Why a test rather than a fix and a note
 *
 * It was ALREADY fixed once. `run-market-data-job.sh:422` carries the full
 * diagnosis — "the first version matched only `mongodb+srv://` ... against a
 * QA cluster that uses plain `mongodb://`, echoed the full credentials" — and
 * the sweep stopped at that one file, leaving the identical bug in
 * `sync-prod-to-qa.sh` and `seed-env.sh`. Naming a bug is not protection from
 * it; this is the protection.
 *
 * ## The property being pinned
 *
 * FAIL CLOSED, not merely "wider regex". A redactor that emits the raw secret
 * when its pattern misses is worse than no redactor, because the output looks
 * deliberate — which is exactly how this survived. Every masker must reduce an
 * unrecognised string to the scheme alone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

/** Every tracked shell script under scripts/ and workers/. */
function shellScripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git" || name === "dist")
        continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".sh")) out.push(full);
    }
  };
  walk(join(REPO, "scripts"));
  walk(join(REPO, "workers"));
  return out;
}

const SCRIPTS = shellScripts();

/** The defect: a mask anchored to `mongodb+srv` with no optional `+srv`. */
const ONE_SCHEME = /mongodb\\?\+srv:\/\/\[\^@\]\*@/;

/**
 * Strip FULL-LINE shell comments only.
 *
 * Needed because these files' own prose quotes the pattern they forbid — the
 * first run of this scan flagged the two files it had just fixed. That is the
 * comment-satisfies-a-scan defect from MONEY-1490's route scan, inverted: there
 * a comment caused a false NEGATIVE, here a false POSITIVE.
 *
 * FULL-LINE only, deliberately. A naive strip from the first `#` would mangle
 * `sed -E 's#...#...#'`, which uses `#` as its DELIMITER — and that expression
 * is the correct masker, so eating it would hide the very thing being checked.
 */
function stripShellComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

describe("connection-string masking in ops scripts (MONEY-1494)", () => {
  it("[premise] finds the scripts it reasons over", () => {
    assert.ok(
      SCRIPTS.length >= 20,
      `only found ${SCRIPTS.length} shell scripts — the walk is stale`,
    );
  });

  it("[premise] at least one script actually masks a URI", () => {
    // Without this, deleting every masker would pass the regression below.
    const withMaskers = SCRIPTS.filter((f) =>
      /mask_uri\(\)|mask_host\(\)/.test(readFileSync(f, "utf8")),
    );
    assert.ok(
      withMaskers.length >= 3,
      `expected >=3 scripts defining a masker, found ${withMaskers.length}`,
    );
  });

  it("REGRESSION: no script masks with a `mongodb+srv`-only pattern", () => {
    const offenders = SCRIPTS.filter((f) =>
      ONE_SCHEME.test(stripShellComments(readFileSync(f, "utf8"))),
    ).map((f) => f.slice(REPO.length + 1));

    assert.deepEqual(
      offenders,
      [],
      `These mask ONLY mongodb+srv:// — QA is plain mongodb://, so the ` +
        `pattern misses and sed prints the password unchanged:\n  ` +
        `${offenders.join("\n  ")}\n\n` +
        `Use the FAIL-CLOSED masker from run-market-data-job.sh:422. A wider ` +
        `regex is not enough: it still emits the raw secret when it misses.`,
    );
  });

  it("every masker FAILS CLOSED on an unrecognised string", () => {
    // The property that separates this from "a wider regex". A masker whose
    // fallthrough echoes its input is the original defect in a new costume.
    const maskers = SCRIPTS.filter((f) =>
      /^mask_(uri|host)\(\) \{/m.test(readFileSync(f, "utf8")),
    );
    const leaky: string[] = [];
    for (const f of maskers) {
      const src = readFileSync(f, "utf8");
      const body =
        /^mask_(?:uri|host)\(\) \{([\s\S]*?)^\}/m.exec(src)?.[1] ?? "";
      if (!body.includes("<redacted>")) leaky.push(f.slice(REPO.length + 1));
    }
    assert.deepEqual(
      leaky,
      [],
      `These maskers have no fail-closed fallthrough — an unrecognised ` +
        `connection string passes through verbatim:\n  ${leaky.join("\n  ")}`,
    );
  });

  /**
   * INLINE redactions count too — MONEY-1494, found by review AFTER the first
   * fix claimed the estate was swept.
   *
   * Both checks above were structurally blind to a FOURTH copy of the regex
   * ~1,000 lines below the three that were fixed:
   *
   *   - `ONE_SCHEME` matches the LITERAL old text `mongodb+srv://[^@]*@`. The
   *     fourth site read `(mongodb(\+srv)?://)[^@/]*@` — a different string,
   *     invisible to it.
   *   - the fail-closed check only reads bodies matched by
   *     `/^mask_(uri|host)\(\) \{/m`, and an inline pipe is not a function.
   *
   * So the estate read as fully swept while a fail-OPEN masker sat in the one
   * branch that runs when mongodump echoes the URI it was handed. It leaked any
   * password containing a `/`, because `[^@/]*` cannot cross one.
   *
   * The rule this pins: a mongodb redaction lives in a NAMED function, so both
   * checks above can find it. An inline `sed` is refused on sight.
   */
  it("REGRESSION: no inline `sed` redacts a mongodb URI", () => {
    const offenders: string[] = [];
    for (const f of SCRIPTS) {
      // Strip the NAMED maskers first — their bodies legitimately contain the
      // sed, and they are the very place this rule wants redactions to live.
      const code = stripShellComments(readFileSync(f, "utf8")).replace(
        /^mask_[a-z_]+\(\) \{[\s\S]*?^\}/gm,
        "",
      );
      for (const line of code.split("\n")) {
        // MATCH THE REDACTION, NOT A URI. The first version of this test
        // looked for `/mongodb(\+srv)?:\/\//` in the line — and a verified
        // mutation proved it blind: the source text of a redaction contains a
        // REGEX for a URI, not a URI. After `mongodb` comes a literal `(`, so
        // the pattern never matched the thing it was written to find.
        //
        // The reliable signal is the REPLACEMENT: a redaction says `***`.
        // `setup-dbm-host.sh`'s DNS SRV lookup mentions `_mongodb._tcp` and
        // pipes through sed to trim a dot — no `***`, correctly not flagged.
        if (
          /\bsed\b/.test(line) &&
          /mongodb/.test(line) &&
          /\*\*\*/.test(line)
        ) {
          offenders.push(
            `${f.slice(REPO.length + 1)}: ${line.trim().slice(0, 70)}`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `A mongodb redaction must live in a NAMED function (mask_uri / ` +
        `mask_stream / mask_host) so the fail-closed check above can read its ` +
        `body. An inline sed is invisible to every guard here, which is how a ` +
        `fail-open fourth copy survived the MONEY-1494 sweep:\n  ` +
        `${offenders.join("\n  ")}`,
    );
  });

  it("a stream masker survives a password containing `/` AND `@`", () => {
    // The exact input the fourth site printed verbatim. `[^@/]*` cannot cross
    // a slash, so the match failed and sed passed the line through.
    const src = readFileSync(
      join(REPO, "scripts", "ops", "sync-prod-to-qa.sh"),
      "utf8",
    );
    const body = /^mask_stream\(\) \{([\s\S]*?)^\}/m.exec(src)?.[1] ?? "";
    assert.ok(body.length > 0, "mask_stream is not defined");
    assert.doesNotMatch(
      body,
      /\[\^@\/\]/,
      "a character class excluding `/` cannot mask a password containing one",
    );
    assert.match(
      body,
      /\[\^\[:space:\]\]/,
      "the credential span must allow any non-whitespace, so `/` and `@` in a " +
        "password are still redacted",
    );
  });

  it("the scan SEES the shape it forbids (mutation check)", () => {
    assert.ok(
      ONE_SCHEME.test(`sed 's|mongodb+srv://[^@]*@|mongodb+srv://***@|'`),
      "the detector cannot see the original defect",
    );
    assert.ok(
      !ONE_SCHEME.test(
        `sed -E 's#^([a-z+]+://)[^:/@]+:[^@]+@([^/?,]+).*#\\1***:***@\\2#'`,
      ),
      "the detector flags the CORRECT form",
    );
  });
});
