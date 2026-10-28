/**
 * Every writer that uploads DOWNLOADED bytes under a stock-document key sniffs
 * the body first — MONEY-1315 (B).
 *
 * ## Why a scan, and not six more harnesses
 *
 * `document-body-guard.ts` was written, exported, tested — and wired into TWO
 * of six writers. Its own header explains where it lives by naming the writer
 * it was placed to reach (`stock-document-fetcher.ts`, "the second writer of
 * this table from a raw header"), and that writer never imported it. Nothing
 * failed. A guard wired at a third of its call sites is worse than no guard,
 * because the ticket reads as closed.
 *
 * The per-writer regression cases live in `money1315-html-write-guard.test.ts`
 * and drive the real `processStockDocumentSync` against injected fakes. They
 * are the right shape and they do not scale: four of the six writers reach
 * Prisma and GCS through module-scope singletons with no injectable seam, so a
 * behavioural case for each would cost more than it proves. What a SCAN can do
 * that a harness cannot is fail on the SEVENTH writer, on the day it lands.
 *
 * ## The rule
 *
 * In any file that builds a stock-document GCS key (`buildFullDocPath` /
 * `buildStockDocPath`), every upload call must be preceded — within the same
 * function's reach — by `mayStoreDocumentBody(`, UNLESS one of:
 *
 *   - the upload declares a content type we GENERATED ourselves
 *     (`text/plain`, `application/json`). Those bodies are formatted text and
 *     JSON snapshots this repo produced; there is no upstream to disbelieve,
 *     and sniffing them would be asking whether our own writer emitted HTML.
 *   - the site is in {@link EXEMPT} with a reason.
 *
 * "Preceded" is a backward text window, not a control-flow analysis. That is
 * deliberately weak in one direction (a guard in an unrelated earlier branch
 * would satisfy it) and strong in the one that matters: DELETING the guard
 * fails, which is the regression this exists for. The premise cases below keep
 * it honest by proving the detector discriminates rather than answering true.
 *
 * Comments are stripped before scanning. `stock-document-sync.ts`'s own
 * MONEY-1315 note contains the line `//   uploadToGCS(...)  ← STORED IT
 * ANYWAY`, and a scan that counted prose as a call site would both miscount the
 * ordinals every exemption key depends on and report an unguarded upload that
 * does not exist.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo root, derived from THIS FILE — never from `process.cwd()`.
 *
 * `yarn test` runs each workspace with its own cwd (here, `workers/`), while a
 * one-off `npx tsx --test` from the repo root does not. A cwd-relative root
 * scans the right files when you check it by hand and NOTHING under the real
 * suite — and a scan that finds nothing reports every assertion green. Its
 * sibling `doc-ingest-publish-coverage.test.ts` passed 6/6 by hand and failed
 * its own premise the first time it ran under `yarn test`.
 */
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const ROOTS = [
  "workers/src/processors",
  "packages/research/src/data-sources",
  "scripts/data",
];

/** The two functions that name a `stock_documents` GCS key. */
const DOC_KEY_BUILDER = /build(?:Full|Stock)DocPath\s*\(/;

/**
 * An upload CALL. `(?<!function )` and the `async function` guard below drop
 * the DECLARATION of `uploadToStorage` in `stock-document-fetcher.ts`, which is
 * a wrapper definition rather than a site that stores anything.
 */
const UPLOAD_CALL =
  /\b(?:deps\.)?(uploadToGCS|uploadToStorage|uploadAttachment|uploadFile)\s*\(/g;

/** Content types this repo GENERATES. Nothing upstream to disbelieve. */
const GENERATED_CONTENT_TYPES = ["text/plain", "application/json"];

/** How far back a guard may sit and still count as guarding the upload. */
const GUARD_WINDOW_CHARS = 2_500;

/**
 * Sites that deliberately do NOT call the shared guard, and why.
 *
 * Keyed `<basename>:<upload fn>:<n-th occurrence>`, matching the convention in
 * `doc-ingest-publish-coverage.test.ts`: naming the occurrence rather than a
 * line survives formatting but still fails when the site itself goes away.
 */
const EXEMPT: Record<string, string> = {
  "nse-announcements-sync.ts:uploadFile:0":
    "ALREADY BODY-CHECKED, one layer up. `downloadAttachment` returns null " +
    "unless `isUsablePdf(buffer)` finds '%PDF-' in the first 1,024 bytes " +
    "(nse-announcements-sync-logic.ts:864), so an interstitial page never " +
    "reaches this upload and no row is written for it. Wiring the shared guard " +
    "here would add a branch that cannot execute and a counter that reports 0 " +
    "forever — a coverage claim with nothing behind it. If that PDF check is " +
    "ever loosened, delete this exemption in the same change",
};

interface Site {
  key: string;
  file: string;
  guarded: boolean;
  generatedContentType: string | null;
}

/**
 * Strip `//` line comments and block comments, preserving length so offsets and
 * line numbers stay meaningful. Deliberately naive about strings containing
 * `//` — none of the scanned files has one inside an upload argument list, and
 * the premise cases would fail loudly if that changed.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j += 1) out += src[j] === "\n" ? "\n" : " ";
      i = stop;
    } else if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

/** Classify one upload call site. Exported so the control cases can drive it. */
export function classifyUploadSite(args: { code: string; index: number }): {
  guarded: boolean;
  generatedContentType: string | null;
} {
  const before = args.code.slice(
    Math.max(0, args.index - GUARD_WINDOW_CHARS),
    args.index,
  );
  const argList = args.code.slice(args.index, args.index + 400);
  const declared =
    GENERATED_CONTENT_TYPES.find((ct) => argList.includes(`"${ct}"`)) ?? null;
  return {
    guarded: before.includes("mayStoreDocumentBody("),
    generatedContentType: declared,
  };
}

function scan(): Site[] {
  const found: Site[] = [];
  for (const root of ROOTS) {
    const dir = join(REPO_ROOT, root);
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of entries.sort()) {
      const raw = readFileSync(join(dir, f), "utf8");
      if (!DOC_KEY_BUILDER.test(raw)) continue;
      const code = stripComments(raw);
      const counts: Record<string, number> = {};
      for (const m of code.matchAll(UPLOAD_CALL)) {
        const fn = m[1]!;
        const index = m.index ?? 0;
        // Skip the DECLARATION of a local upload wrapper.
        if (/\bfunction\s+$/.test(code.slice(Math.max(0, index - 20), index))) {
          continue;
        }
        const n = counts[fn] ?? 0;
        counts[fn] = n + 1;
        found.push({
          key: `${f}:${fn}:${n}`,
          file: join(root, f),
          ...classifyUploadSite({ code, index }),
        });
      }
    }
  }
  return found;
}

describe("MONEY-1315 (B) — every document-byte writer sniffs the body", () => {
  it("[premise] the scan finds upload sites at all", () => {
    // Without this, a drifted regex or a wrong REPO_ROOT reports zero sites and
    // every assertion below passes over an empty set.
    const sites = scan();
    assert.ok(
      sites.length >= 10,
      `the scan found only ${sites.length} upload sites under a document key; ` +
        "UPLOAD_CALL, DOC_KEY_BUILDER or ROOTS has drifted",
    );
  });

  it("[premise] the scan sees BOTH guarded and unguarded sites", () => {
    // Proves the detector discriminates. Stuck on true makes the main
    // assertion vacuous; stuck on false makes the exemption list the only
    // thing under test.
    const sites = scan();
    assert.ok(
      sites.some((s) => s.guarded),
      "no site detected as guarded",
    );
    assert.ok(
      sites.some((s) => !s.guarded),
      "every site detected as guarded — the detector is not discriminating",
    );
  });

  it("[control] the detector reads a real guard, not a mention of one", () => {
    // Drives the SAME function the scan uses, on synthetic input — the shape of
    // a control that can actually go red (job-build-provenance.test.ts:442).
    const guarded =
      "const gate = mayStoreDocumentBody({ gcsPath, body: buffer });\n" +
      "if (!gate.store) return;\n" +
      "await uploadToGCS(gcsPath, buffer, contentType);";
    const unguarded = "await uploadToGCS(gcsPath, buffer, contentType);";

    assert.equal(
      classifyUploadSite({
        code: guarded,
        index: guarded.indexOf("uploadToGCS("),
      }).guarded,
      true,
      "the detector cannot see a guard that is really there",
    );
    assert.equal(
      classifyUploadSite({
        code: unguarded,
        index: unguarded.indexOf("uploadToGCS("),
      }).guarded,
      false,
      "the detector reports a guard where there is none",
    );

    // And a guard beyond the window does NOT count — otherwise the rule would
    // degrade to "the file mentions the guard somewhere", which is exactly the
    // state MONEY-1315 shipped in: the module was imported by two writers and
    // the scan would have called all six covered.
    const tooFar =
      "const gate = mayStoreDocumentBody({ gcsPath, body: buffer });\n" +
      "x".repeat(GUARD_WINDOW_CHARS + 100) +
      "\nawait uploadToGCS(gcsPath, buffer, contentType);";
    assert.equal(
      classifyUploadSite({
        code: tooFar,
        index: tooFar.lastIndexOf("uploadToGCS("),
      }).guarded,
      false,
    );
  });

  it("[control] comments are stripped, so prose is not a call site", () => {
    // `stock-document-sync.ts` really does contain
    // `//   uploadToGCS(...)  ← STORED IT ANYWAY` inside its MONEY-1315 note.
    // Counting it would shift every ordinal an exemption key depends on AND
    // report an unguarded upload that does not exist.
    const withProse =
      "// uploadToGCS(gcsPath, buffer) <- this is prose\n" +
      "/* uploadFile({ file }) also prose */\n" +
      "await uploadToGCS(real, bytes, type);";
    const stripped = stripComments(withProse);
    assert.equal(
      [...stripped.matchAll(UPLOAD_CALL)].length,
      1,
      "comment stripping did not remove the prose call sites",
    );
    assert.equal(
      stripped.length,
      withProse.length,
      "stripComments must preserve length, or every offset shifts",
    );
  });

  it("no writer of downloaded bytes uploads without sniffing first", () => {
    const offenders = scan()
      .filter(
        (s) =>
          !s.guarded && s.generatedContentType === null && !(s.key in EXEMPT),
      )
      .map((s) => `${s.file} (${s.key})`);
    assert.deepEqual(
      offenders,
      [],
      "these sites upload bytes fetched from an upstream under a " +
        "stock-document key WITHOUT calling mayStoreDocumentBody first. An " +
        "interstitial or challenge page then lands as a document with a " +
        "gcsPath, which is the column every reader takes as proof the bytes " +
        "are there:\n  " +
        offenders.join("\n  "),
    );
  });

  it("the six real byte writers are the ones guarded", () => {
    // Named explicitly so a REMOVAL is as loud as an addition — a guard that
    // quietly leaves one of these files would otherwise only show up as a
    // number in the premise case.
    const guardedFiles = new Set(
      scan()
        .filter((s) => s.guarded)
        .map((s) => s.key.split(":")[0]),
    );
    for (const f of [
      "stock-document-sync.ts",
      "stock-document-fetcher.ts",
      "annual-reports-sync.ts",
      "bse-announcements-sync.ts",
      "backfill-bse-results.ts",
    ]) {
      assert.ok(
        guardedFiles.has(f),
        `${f} no longer sniffs the body before uploading document bytes`,
      );
    }
  });

  it("[ratchet] every exemption still names a real, unguarded site", () => {
    // A stale permit reads as a considered decision about a site that no longer
    // exists, and quietly widens to cover a NEW site landing at the same
    // occurrence index.
    const byKey = new Map(scan().map((s) => [s.key, s]));
    const stale: string[] = [];
    for (const key of Object.keys(EXEMPT)) {
      const site = byKey.get(key);
      if (!site) stale.push(`${key} — no such upload site any more`);
      else if (site.guarded) {
        stale.push(`${key} — now guarded; drop the exemption`);
      }
    }
    assert.deepEqual(stale, [], `stale exemptions:\n  ${stale.join("\n  ")}`);
  });

  it("every exemption carries a REASON, not an empty string", () => {
    for (const [k, v] of Object.entries(EXEMPT)) {
      assert.ok(v.trim().length > 20, `${k} has no real reason`);
    }
  });

  it("the exempted nse-announcements site really is body-checked elsewhere", () => {
    // The exemption above is only honest while `isUsablePdf` actually tests the
    // BYTES. If it degrades to a size check, an interstitial reaches that
    // upload and the exemption becomes a permit for the defect. Asserted
    // against the source that owns the rule rather than restated here.
    const logic = readFileSync(
      join(REPO_ROOT, "workers/src/processors/nse-announcements-sync-logic.ts"),
      "utf8",
    );
    assert.match(
      logic,
      /export function isUsablePdf[\s\S]{0,600}%PDF-/,
      "isUsablePdf no longer checks for the %PDF- magic bytes, so " +
        "nse-announcements-sync's upload is no longer body-checked and its " +
        "exemption in this file must be removed",
    );
  });
});
