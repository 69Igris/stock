/**
 * Every `stock_documents` writer either ANNOUNCES or is exempt — MONEY-1314.
 *
 * There are EIGHTEEN writers across eight files (counted 2026-09-02; it read
 * "fifteen" while the scan found sixteen, and MONEY-1315 (B) added the two
 * refusal paths). A realtime lane that misses
 * one has no symptom: the document is stored correctly, the sync reports
 * success, and the row simply never reaches the ingest lane until a backfill
 * pass happens to select it. Nothing counts it, nothing alerts on it.
 *
 * So this scan enumerates the writers from SOURCE and requires each to be
 * either followed by `publishDocumentIngest`, or on the exemption list below
 * with a reason. The exemption list is a RATCHET: an entry naming a site that
 * no longer exists fails, so it cannot rot into a blanket permit.
 *
 * ## MONEY-1323 — the keys used to be POSITIONAL, and positions move
 *
 * Each exemption was keyed `<file>:<kind>:<n-th occurrence>` —
 * `stock-document-sync.ts:upsert:2`. That survives reformatting, which was the
 * property it was chosen for and which it really does have. It does NOT survive
 * an INSERTION above an exempt ordinal: every later site shifts down one, every
 * later exemption silently re-points at a DIFFERENT write, and the ratchet
 * cannot tell — it only ever asserted "the key exists and does not announce",
 * never "the site is the one the reason describes".
 *
 * That is not a thought experiment. Measured in the week this landed: a new
 * write appeared at index 3 in `stock-document-sync.ts` and shifted two
 * announcing sites from 3,4 to 4,5. The exemptions held ONLY because everything
 * that moved happened to be non-exempt. Had the new write landed one function
 * earlier, `stock-document-sync.ts:upsert:3` — the HTML-refusal permit — would
 * have silently transferred to `storeNSEFiling`, a live PDF writer, and the
 * scan would have gone on passing while a real filing stopped reaching the
 * ingest lane. A permit that moves is worse than no permit: it reads as a
 * considered decision about a site nobody considered.
 *
 * The key is now what IDENTIFIES the site rather than where it sits:
 *
 *     <file>:<enclosing function>:<write kind>[:<docType literal>]
 *
 * Both halves come out of the same scan the writers already need. The enclosing
 * function is the natural name for a write site — the exemption reasons were
 * already written in terms of it ("quarantineHtmlDownload — the REFUSAL path"),
 * so the key now says out loud what the reason always claimed. The `docType`
 * literal is appended when the upsert body carries one, and it is not optional
 * decoration: `processStockDocumentSync` writes TWO exempt documents from one
 * function (`financial_statement` and `screener_financials`), so the function
 * name alone would collide and one permit would cover both.
 *
 * A collision is now a LOUD FAILURE rather than a silent ordinal — see
 * `[premise] every write site has a UNIQUE key`. If two sites ever produce one
 * key, the scan says so and stops, instead of quietly making them
 * interchangeable, which is the defect this ticket is about restated.
 *
 * Insertion-invariance is the property to keep when editing this file: adding a
 * write anywhere must not change any OTHER site's key. Reformatting must not
 * either — both are asserted below, and the second is why line numbers are
 * still not used.
 *
 * ## …and the ANNOUNCE half stayed positional for a release
 *
 * Fixing the key fixed half the guard. `announces` was still a raw
 * `src.slice(at, at + 3_000)` — ~75 lines that stop at no scope boundary — so a
 * SILENT writer added anywhere in the 3,000 characters above an announcing one
 * read `announces: true` off its NEIGHBOUR's publish call. It then needed no
 * exemption, `no writer both fails to announce AND lacks an exemption` passed,
 * the ratchet passed, and its documents never reached the ingest lane. That is
 * the MONEY-1314 defect itself, reproduced by the guard built to prevent it,
 * and it was the last silent hole this scan had.
 *
 * The window now stops at the EARLIEST of three bounds:
 *
 *     at + 3,000 chars     the original generous cap, kept
 *     the enclosing function's `}`     a publish in the next function down is
 *                                      not reachable from this write
 *     the NEXT write site  a publish after a second write announces THAT one
 *
 * The third was not in the original diagnosis and was found by MUTATION: with
 * only the first two, a probe writer inserted into the SAME function as an
 * announcing write — ten lines above it — still borrowed its publish and the
 * suite stayed green at 16/16. Two writes in one function do NOT collide on the
 * key when their `docType` literals differ, so the uniqueness premise does not
 * catch it either. Measured before adding it: 0 of 18 live sites change
 * verdict.
 *
 * The `docType` was positional in the same way — read from a 1,200-character
 * forward window that can reach past the end of the call and pick up a literal
 * from a later, unrelated statement. It is now bounded by the write call's own
 * matching `)`, so the key depends only on the site.
 *
 * Both bounds are brace/paren walks over RAW source. That is not a new
 * assumption: the enclosing-function walk has always counted raw braces, so if
 * it were unsound every KEY would already be wrong. `[premise] every scanned
 * file is brace- and paren-BALANCED` pins it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo root, derived from THIS FILE — never from `process.cwd()`.
 *
 * `yarn test` runs each workspace with its own CWD (here, `workers/`), while a
 * one-off `npx tsx --test` from the repo root does not. A CWD-relative root
 * therefore scans the right files when you check it by hand and NOTHING in the
 * real suite — and a scan that finds nothing reports every assertion green.
 *
 * That is not hypothetical: this file passed 6/6 by hand and failed its own
 * `[premise]` case the first time it ran under `yarn test`. The premise case
 * is the only reason the vacuity was visible.
 */
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const ROOTS = [
  "workers/src/processors",
  "workers/src/lib",
  "packages/research/src/tools",
  "packages/research/src/data-sources",
  "scripts/data",
];

const WRITE_CALL =
  /\b(?:prisma|db|deps\.prisma)\.stockDocument\.(upsert|create)\s*\(/g;

/**
 * The `docType` a write site names, when it names one literally.
 *
 * Read out of the first ~1,200 characters of the call, which reaches the
 * `where` key and the head of `create` in every shape here. A site whose
 * docType is a VARIABLE (`args.docType`, `key.docType`) contributes nothing —
 * correctly, because the value is not a property of the site — and those sites
 * are all alone in their function anyway.
 */
const DOC_TYPE_LITERAL = /\bdocType:\s*"([^"]+)"/;

/**
 * The name of the function a write site sits in.
 *
 * Walks OUT through balanced braces to the first unmatched `{`, then asks
 * whether the text before it opens a function body; if not, keeps walking. Two
 * details are load-bearing and both were found by getting them wrong:
 *
 *   BALANCED GROUPS ARE COLLAPSED going backwards, so a TypeScript return type
 *   — `): Promise<{ ok: boolean }> {` — does not hide the parameter list that
 *   identifies the header.
 *
 *   THE WALK STOPS AT AN UNMATCHED `{` OR A `;`. Both are the boundary of the
 *   previous statement or the enclosing scope, and neither can appear inside a
 *   real header. Without the stop, a short function's inner block reads back
 *   past its own signature and is mistaken for a nested function.
 *
 * Deliberately NOT imported from `packages/datadog/__tests__/`, which has a
 * fuller version for the job-outcome guards: that is a different workspace with
 * its own tsconfig, and a cross-workspace import from one test tree into
 * another buys shared code at the price of a build edge nobody expects. The
 * question here is also narrower — a name, with no `finally` or dominance
 * analysis — so the two are kept independent and each is pinned by its own
 * cases.
 */
export function enclosingFunctionName(src: string, at: number): string {
  return enclosingFunctionBody(src, at)?.name ?? "<module>";
}

/**
 * The enclosing function's NAME and the offset of the `{` that opens its body.
 *
 * The open brace is what {@link scanSource} needs to find the function's END,
 * and the end is what bounds the announce window — see the MONEY-1323 note in
 * the header. Splitting it out rather than duplicating the walk keeps the key
 * and the window derived from ONE decision about which function a write is in;
 * two walks that could disagree is the shape the exemption keys were rewritten
 * to remove.
 */
function enclosingFunctionBody(
  src: string,
  at: number,
): { name: string; open: number } | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === "}") {
      depth++;
      continue;
    }
    if (c !== "{") continue;
    if (depth > 0) {
      depth--;
      continue;
    }
    const header = headerBefore(src, i);
    const name = functionHeaderName(header);
    if (name !== null) return { name, open: i };
    // A plain block — an `if`, a `for`, a `try`. Keep walking outward.
  }
  return null;
}

/**
 * The `}` matching the `{` at `open`, or the end of the file.
 *
 * Counts braces on RAW source, which is the SAME assumption the backwards walk
 * above already makes and is therefore not a new class of fragility: if raw
 * brace counting were unsound here, every exemption KEY would already be wrong.
 * Both are pinned by `[premise] every key names a function` and by the
 * brace-balance case below.
 */
function matchingClose(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** The `)` matching the `(` at `open`, or the end of the file. */
function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** Text before `open`, `{…}` groups collapsed, stopping at the scope boundary. */
function headerBefore(src: string, open: number, budget = 400): string {
  let out = "";
  let i = open - 1;
  while (i >= 0 && out.length < budget) {
    if (src[i] === "}") {
      let d = 0;
      let j = i;
      for (; j >= 0; j--) {
        if (src[j] === "}") d++;
        else if (src[j] === "{") {
          d--;
          if (d === 0) break;
        }
      }
      if (j < 0) break;
      i = j - 1;
      out = "{}" + out;
      continue;
    }
    if (src[i] === "{" || src[i] === ";") break;
    out = src[i]! + out;
    i--;
  }
  return out;
}

/** The function name a collapsed header declares, or null if it is not one. */
function functionHeaderName(header: string): string | null {
  if (
    /\b(?:if|for|while|switch|catch|with)\s*\((?:[^()]|\([^()]*\))*\)\s*$/.test(
      header,
    )
  ) {
    return null;
  }
  const kw = header.lastIndexOf("function");
  if (kw >= 0 && /\)\s*(?::[\s\S]*)?$/.test(header)) {
    const m = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(header.slice(kw));
    if (m) return m[1]!;
  }
  const arrow = header.lastIndexOf("=>");
  if (arrow >= 0 && /=>\s*$/.test(header)) {
    const m =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=[^=]*$/.exec(
        header.slice(0, arrow),
      );
    if (m) return m[1]!;
    return "<anonymous>";
  }
  const method =
    /(?:^|[\s(])(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?::[\s\S]*)?$/.exec(
      header,
    );
  return method ? method[1]! : null;
}

export interface WriteSite {
  key: string;
  file: string;
  fn: string;
  announces: boolean;
}

/**
 * Every `stock_documents` write in one source file, keyed by IDENTITY.
 *
 * Exported and pure so the insertion-invariance and reformatting cases below
 * can drive it with a fixture instead of editing a real processor to prove a
 * property about keys.
 */
export function scanSource(fileLabel: string, src: string): WriteSite[] {
  const basename = fileLabel.split("/").pop()!;
  const out: WriteSite[] = [];
  const writeOffsets = [...src.matchAll(new RegExp(WRITE_CALL.source, "g"))]
    .map((m) => m.index ?? 0)
    .sort((a, b) => a - b);
  for (const m of src.matchAll(WRITE_CALL)) {
    const kind = m[1]!;
    const at = m.index ?? 0;
    const body = enclosingFunctionBody(src, at);
    const fn = body?.name ?? "<module>";

    // "Announces" = a publish call after the write and INSIDE THE SAME
    // FUNCTION. Both halves of that are load-bearing, and only the first one
    // used to be.
    //
    // MONEY-1323 made the exemption keys identity-based and left this half
    // positional: a raw `src.slice(at, at + 3_000)` window. 3,000 characters is
    // ~75 lines, and it does not stop at a `}`. So a SILENT writer added within
    // ~3,000 characters ABOVE an announcing one read `announces: true` off its
    // NEIGHBOUR's publish call, needed no exemption, and both ratchet arms
    // stayed green while its documents never reached the ingest lane — the same
    // defect the keys were fixed for, one field over, and the last silent hole
    // this guard had. Verified against a fixture; zero divergence on the tree
    // this landed on, which is luck rather than safety.
    //
    // The function boundary is the right stop because it is what the KEY is
    // already keyed on: a publish that vouches for a write has to be reachable
    // from it, and a call in the NEXT function is not. The 3,000-char cap stays
    // as the inner bound — generous on purpose, the upsert bodies here run to
    // ~35 lines and a tight window would report a false miss on a correctly
    // wired site — but the function's closing brace now wins whenever it comes
    // first.
    //
    // THE FUNCTION BOUNDARY ALONE IS NOT ENOUGH, and that was found by
    // mutation rather than by reading: a silent writer inserted into the SAME
    // function as an announcing one, ten lines above it, still borrowed its
    // publish and the guard stayed green at 16/16. Two writes in one function
    // do not collide on the key when their `docType` literals differ, so the
    // uniqueness premise does not catch it either. Hence the third bound — the
    // NEXT `stock_documents` write in the file. A publish that sits after
    // another write announces THAT write; reading it as vouching for both is
    // the same borrowing one scope down. Measured before adding it: 0 of 18
    // live sites change verdict, so it costs nothing today and closes the case
    // the other two bounds cannot express.
    const fnEnd = body ? matchingClose(src, body.open) : src.length;
    const nextWrite = writeOffsets.find((x) => x > at) ?? src.length;
    const after = src.slice(at, Math.min(at + 3_000, fnEnd, nextWrite));

    // The `docType` is read out of the write call's OWN argument list, bounded
    // by the matching `)`. It used to be a 1,200-character forward window,
    // which can reach past the end of the call and pick a `docType:` literal
    // off a LATER, unrelated statement — at which point the key stops being
    // pure identity and starts depending on what happens to sit near the site.
    const argsEnd = matchingParen(src, at + m[0]!.length - 1);
    const docType = DOC_TYPE_LITERAL.exec(src.slice(at, argsEnd));

    out.push({
      key: `${basename}:${fn}:${kind}${docType ? `:${docType[1]}` : ""}`,
      file: fileLabel,
      fn,
      announces: after.includes("publishDocumentIngest("),
    });
  }
  return out;
}

/**
 * Sites that deliberately do NOT announce, and why.
 *
 * Each key is `<file basename>:<enclosing function>:<write kind>` plus the
 * `docType` literal when the site names one. Naming the SITE rather than its
 * ordinal means the entry survives both formatting AND an insertion anywhere
 * else in the file, while still failing when the site itself goes away or is
 * renamed — see the MONEY-1323 note in the header.
 */
const EXEMPT: Record<string, string> = {
  "stock-document-sync.ts:processStockDocumentSync:upsert:financial_statement":
    "text/plain financial_statement — the ingest lane is PDF-only and would " +
    "mark it UNREADABLE on arrival, spending a message to write a status the " +
    "writer already knows",
  "stock-document-sync.ts:processStockDocumentSync:upsert:screener_financials":
    "text/plain screener_financials — same reason",
  "stock-document-sync.ts:storeScreenerJsonSnapshot:upsert":
    "application/json payload — same reason",
  "stock-document-sync.ts:quarantineHtmlDownload:upsert":
    "MONEY-1315 quarantineHtmlDownload — the REFUSAL path. The body sniffed " +
    'as an HTML page, so the row is stored with gcsPath "" and a terminal ' +
    "status precisely BECAUSE there are no document bytes. Announcing would " +
    "hand the lane a key it cannot read, to learn what this writer already " +
    "decided",
  "annual-reports-sync.ts:quarantineHtmlAnnualReport:upsert:annual_report":
    "MONEY-1315 quarantineHtmlAnnualReport — the REFUSAL path, the sibling of " +
    "stock-document-sync's. NSE served an interstitial page under our own " +
    'hardcoded application/pdf, so the row carries gcsPath "" and a terminal ' +
    "status BECAUSE there are no document bytes. Announcing would hand the " +
    "lane a key it cannot read",
  "annual-reports-sync.ts:storeIntegratedFiling:upsert:integrated_filing":
    "application/json integrated-filing payload — the ingest lane is PDF-only",
  "fetch-youtube-transcript.ts:persistYoutubeTranscript:upsert:video_transcript":
    "a YouTube transcript, not a filing; no gcsPath and no PDF",
  "stock-document-fetcher.ts:quarantineHtmlDownload:upsert":
    "MONEY-1315 quarantineHtmlDownload — the request-time REFUSAL path. No " +
    "document bytes exist, so there is nothing for the lane to read; and " +
    "packages/research cannot import from workers/ in any case",
  "stock-document-fetcher.ts:fetchAndStoreFinancials:upsert:financial_statement":
    "request-time research fetch in packages/research, which cannot import " +
    "from workers/ — the backfill covers these rows",
  "stock-document-fetcher.ts:fetchAndStoreNSEFilings:create":
    "same package boundary",
  "stock-document-fetcher.ts:fetchAndStoreScreenerDocs:create":
    "same package boundary",
  "rag-enqueue.ts:enqueueDocumentForRag:create":
    "enqueues for the RAG/embed lane, not the figures lane",
  "backfill-bse-results.ts:writeOne:upsert":
    "a one-shot repair script run by hand; it is not a live writer, and the " +
    "backfill job reaches whatever it stores",
};

function scan(): WriteSite[] {
  const found: WriteSite[] = [];
  for (const root of ROOTS) {
    const dir = join(REPO_ROOT, root);
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of entries) {
      const src = readFileSync(join(dir, f), "utf8");
      found.push(...scanSource(join(root, f), src));
    }
  }
  return found;
}

describe("MONEY-1314 — every stock_documents writer announces or is exempt", () => {
  it("[premise] the scan finds writers at all", () => {
    // Without this, a broken regex reports zero sites and every assertion
    // below passes vacuously — the exact shape this repo has been bitten by.
    const sites = scan();
    assert.ok(
      sites.length >= 12,
      `the scan found only ${sites.length} stock_documents writers; the ` +
        "regex or the ROOTS list has drifted",
    );
  });

  it("[premise] the scan sees BOTH announcing and non-announcing sites", () => {
    // Proves the `announces` detector discriminates. A detector stuck on true
    // would make the main assertion vacuous; stuck on false would make the
    // exemption list the only thing under test.
    const sites = scan();
    assert.ok(
      sites.some((s) => s.announces),
      "no site detected as announcing",
    );
    assert.ok(
      sites.some((s) => !s.announces),
      "every site detected as announcing — the detector is not discriminating",
    );
  });

  it("[premise] every write site has a UNIQUE key", () => {
    // MONEY-1323. The whole scheme rests on one key naming one site. Two sites
    // sharing a key makes them interchangeable, which is the positional defect
    // this replaces wearing a different hat — so a collision FAILS here rather
    // than being resolved by an ordinal nobody would notice re-pointing.
    //
    // `processStockDocumentSync` writes two exempt documents, which is why the
    // `docType` literal is part of the key at all.
    const seen = new Map<string, string[]>();
    for (const s of scan()) {
      seen.set(s.key, [...(seen.get(s.key) ?? []), s.file]);
    }
    const collisions = [...seen.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([key, files]) => `${key} -> ${files.length} sites (${files[0]})`);
    assert.deepEqual(
      collisions,
      [],
      "two write sites produce the same key, so one exemption would cover " +
        "both and a change to either would look like a change to the other. " +
        "Add a discriminator the SITE carries — a docType literal, or split " +
        "the function.\n  " +
        collisions.join("\n  "),
    );
  });

  it("[premise] every key names a function, not the module", () => {
    // `<module>` means the walk fell off the top without recognising a header
    // — a silent degradation that would make every site in that file share one
    // key and land in the collision check above for the wrong reason.
    const homeless = scan().filter(
      (s) => s.fn === "<module>" || s.fn === "<anonymous>",
    );
    assert.deepEqual(
      homeless.map((s) => `${s.file} (${s.key})`),
      [],
      "the enclosing-function walk did not resolve a name for these sites",
    );
  });

  it("no writer both fails to announce AND lacks an exemption", () => {
    const missing = scan()
      .filter((s) => !s.announces && !(s.key in EXEMPT))
      .map((s) => `${s.file} (${s.key})`);
    assert.deepEqual(
      missing,
      [],
      "these stock_documents writers neither announce to the ingest lane nor " +
        "carry an exemption. A missed writer has NO symptom — the row is " +
        "stored, the sync reports success, and the document silently never " +
        "reaches the lane:\n  " +
        missing.join("\n  "),
    );
  });

  it("[ratchet] every exemption still names a real, non-announcing site", () => {
    // A stale permit is worse than no permit: it reads as a considered
    // decision about a site that no longer exists. Under the OLD positional
    // keys it could also quietly widen to cover a NEW site that landed at the
    // same ordinal; under identity keys a rename or a move fails here instead,
    // which is the point of MONEY-1323.
    const sites = scan();
    const byKey = new Map(sites.map((s) => [s.key, s]));
    const stale: string[] = [];
    for (const key of Object.keys(EXEMPT)) {
      const site = byKey.get(key);
      if (!site) stale.push(`${key} — no such write site any more`);
      else if (site.announces)
        stale.push(`${key} — now announces; drop the exemption`);
    }
    assert.deepEqual(stale, [], `stale exemptions:\n  ${stale.join("\n  ")}`);
  });

  it("every exemption carries a REASON, not an empty string", () => {
    for (const [k, v] of Object.entries(EXEMPT)) {
      assert.ok(v.trim().length > 20, `${k} has no real reason`);
    }
  });

  it("the five live PDF writers are the ones announcing", () => {
    // Named explicitly so a REMOVAL is as loud as an addition. These are the
    // jobs that feed the parseable corpus.
    const announcing = new Set(
      scan()
        .filter((s) => s.announces)
        .map((s) => s.key.split(":")[0]),
    );
    for (const f of [
      "stock-document-sync.ts",
      "bse-announcements-sync.ts",
      "nse-announcements-sync.ts",
      "annual-reports-sync.ts",
    ]) {
      assert.ok(
        announcing.has(f),
        `${f} no longer announces to the ingest lane`,
      );
    }
  });
});

describe("MONEY-1323 — an exempt key names the SITE, not its position", () => {
  /**
   * Two writes in one file, the second exempt. The shape the real defect took:
   * a new write lands ABOVE an exempt one and every later ordinal shifts.
   */
  const BEFORE = [
    "async function storeFiling(): Promise<void> {",
    '  await prisma.stockDocument.upsert({ where: { docType: "annual_report" } });',
    "  await publishDocumentIngest(doc.id);",
    "}",
    "async function quarantineHtmlDownload(): Promise<void> {",
    '  await prisma.stockDocument.upsert({ where: { docType: "annual_report" } });',
    "}",
  ].join("\n");

  const AFTER_INSERTION = [
    "async function storeSnapshot(): Promise<void> {",
    '  await prisma.stockDocument.upsert({ where: { docType: "screener_json" } });',
    "  await publishDocumentIngest(doc.id);",
    "}",
    BEFORE,
  ].join("\n");

  it("an INSERTION above an exempt site does not move its key", () => {
    // Under `<file>:<kind>:<n>` the exempt site was `f.ts:upsert:1` before and
    // `f.ts:upsert:2` after, so the permit stayed on ordinal 1 — which now
    // names `storeFiling`, a LIVE announcing writer. Silent transfer.
    const before = scanSource("f.ts", BEFORE);
    const after = scanSource("f.ts", AFTER_INSERTION);

    const exemptKey = "f.ts:quarantineHtmlDownload:upsert:annual_report";
    assert.ok(
      before.some((s) => s.key === exemptKey),
      `the fixture's exempt site should key as ${exemptKey}, got ` +
        JSON.stringify(before.map((s) => s.key)),
    );
    assert.ok(
      after.some((s) => s.key === exemptKey),
      "the exempt site's key MOVED when an unrelated write was inserted above " +
        "it — every later exemption has just re-pointed at a different site",
    );

    // …and the surviving sites keep their identities, one for one.
    for (const s of before) {
      assert.ok(
        after.some((a) => a.key === s.key),
        `${s.key} lost its identity to an insertion elsewhere in the file`,
      );
    }
    assert.equal(after.length, before.length + 1, "the new write must be SEEN");
  });

  it("[control] the OLD positional key really would have transferred", () => {
    // The improvement, demonstrated rather than asserted. Re-derive the old
    // scheme over the same two fixtures and watch the permit land on the
    // announcing writer.
    const positional = (src: string): string[] => {
      const counts: Record<string, number> = {};
      return [...src.matchAll(WRITE_CALL)].map((m) => {
        const kind = m[1]!;
        const n = counts[kind] ?? 0;
        counts[kind] = n + 1;
        return `f.ts:${kind}:${n}`;
      });
    };

    // `positional` numbers matches IN ORDER, so index 1 spells "…:upsert:1"
    // for any input holding two upserts. Asserting that literal against that
    // literal is true by construction and says nothing about these fixtures —
    // it was two of this case's three assertions. What a control has to show is
    // not that the key is STABLE but what the stable key now POINTS AT, so the
    // sites are read out of the same scan the real guard uses.
    assert.equal(
      positional(BEFORE)[1],
      positional(AFTER_INSERTION)[1],
      "the old scheme's ordinal 1 must survive the insertion unchanged — that " +
        "is the mechanism of the transfer, not an incidental detail",
    );

    const before = scanSource("f.ts", BEFORE);
    const after = scanSource("f.ts", AFTER_INSERTION);
    assert.equal(
      before[1]!.fn,
      "quarantineHtmlDownload",
      "ordinal 1 must START on the exempt refusal path, or this control is " +
        "pointed at the wrong write and proves nothing",
    );
    assert.equal(before[1]!.announces, false, "…and it must be SILENT");
    assert.equal(
      after[1]!.fn,
      "storeFiling",
      "the fixture no longer reproduces the transfer — repoint it, or this " +
        "control has stopped proving the defect exists",
    );
    assert.equal(
      after[1]!.announces,
      true,
      "the permit at ordinal 1 must land on a LIVE ANNOUNCING writer for the " +
        "transfer to be the dangerous one this ticket is about",
    );
  });

  it("REFORMATTING does not change any key", () => {
    // The property the positional scheme was chosen for, and it must survive
    // the change. Reflow the fixture hard: collapse the argument objects, move
    // every brace, strip the indentation.
    const reflowed = BEFORE.replace(/\n\s*/g, " ")
      .replace(/\{ /g, "{")
      .replace(/ \}/g, "}");
    assert.deepEqual(
      scanSource("f.ts", reflowed).map((s) => s.key),
      scanSource("f.ts", BEFORE).map((s) => s.key),
      "reformatting moved a key — line- or layout-sensitive keying has crept " +
        "back in, and the exemption list will be regenerated blindly",
    );
  });

  it("RENAMING an exempt function fails loudly instead of transferring", () => {
    // The other half of "identity". A permit must not follow a site through a
    // rename silently: the reasons here are written in terms of the function
    // ("quarantineHtmlDownload — the REFUSAL path"), so a rename is a change
    // to what the permit is about and has to be re-read by a human.
    const renamed = BEFORE.replace("quarantineHtmlDownload", "refuseHtmlBody");
    const keys = scanSource("f.ts", renamed).map((s) => s.key);
    assert.ok(
      !keys.includes("f.ts:quarantineHtmlDownload:upsert:annual_report"),
      "the old key still resolves after a rename",
    );
    assert.ok(keys.includes("f.ts:refuseHtmlBody:upsert:annual_report"));
  });

  it("a SILENT writer above an announcing one does not borrow its publish", () => {
    // MONEY-1323's last silent hole, and the one this whole scheme exists to
    // close. The exemption KEY was made identity-based; the `announces` flag
    // was left positional — a raw 3,000-character forward window, ~75 lines,
    // that did not stop at a `}`. So a new silent writer landing anywhere in
    // the ~3,000 characters ABOVE an announcing one read `announces: true` off
    // its NEIGHBOUR's publish call. It then needed no exemption, the
    // no-writer-lacks-a-permit case passed, the ratchet passed, and its
    // documents silently never reached the ingest lane — which is the ORIGINAL
    // MONEY-1314 defect, reintroduced by the guard meant to prevent it.
    const src = [
      "async function storeQuietly(): Promise<void> {",
      '  await prisma.stockDocument.upsert({ where: { docType: "annual_report" } });',
      "}",
      "async function storeLoudly(): Promise<void> {",
      '  await prisma.stockDocument.upsert({ where: { docType: "press_release" } });',
      "  await publishDocumentIngest(doc.id);",
      "}",
    ].join("\n");

    const sites = scanSource("f.ts", src);
    assert.deepEqual(
      sites.map((s) => [s.key, s.announces]),
      [
        ["f.ts:storeQuietly:upsert:annual_report", false],
        ["f.ts:storeLoudly:upsert:press_release", true],
      ],
      "a write must be vouched for by a publish it can actually REACH — one " +
        "in the next function down is not one",
    );

    // …and the control, in the house style: the unbounded window really did
    // report the silent site as announcing, so this case is proving a defect
    // rather than restating the implementation.
    const at = src.indexOf("prisma.stockDocument.upsert");
    assert.ok(
      src.slice(at, at + 3_000).includes("publishDocumentIngest("),
      "the fixture no longer fits inside one 3,000-character window — widen " +
        "it, or this case has stopped proving anything",
    );
  });

  it("a SILENT writer in the SAME function does not borrow the publish either", () => {
    // Found by MUTATION, not by reading, and it is why the function boundary
    // is not the whole fix: a probe writer inserted ten lines above the
    // announcing write in `nse-announcements-sync.ts` — same function, 2,218
    // characters — left the guard green at 16/16 with the function bound
    // already in place. Two writes in one function do not collide on the key
    // when their `docType`s differ, so the uniqueness premise misses it too.
    //
    // The window therefore also stops at the NEXT write. A publish following a
    // second write announces THAT one.
    const src = [
      "async function storeBoth(): Promise<void> {",
      '  await prisma.stockDocument.upsert({ where: { docType: "annual_report" } });',
      "  const stored = await prisma.stockDocument.upsert({",
      '    where: { docType: "press_release" },',
      "  });",
      "  await publishDocumentIngest(stored);",
      "}",
    ].join("\n");

    assert.deepEqual(
      scanSource("f.ts", src).map((s) => [s.key, s.announces]),
      [
        ["f.ts:storeBoth:upsert:annual_report", false],
        ["f.ts:storeBoth:upsert:press_release", true],
      ],
      "the FIRST write is silent — the publish below it announces the SECOND",
    );

    // The control: both bounds that came before this one are satisfied here,
    // so without the stop-at-next-write rule the first site reads as announcing.
    const at = src.indexOf("prisma.stockDocument.upsert");
    assert.ok(
      src.slice(at, at + 3_000).includes("publishDocumentIngest("),
      "the fixture must fit in one 3,000-character window",
    );
    assert.equal(
      scanSource("f.ts", src)[0]!.fn,
      scanSource("f.ts", src)[1]!.fn,
      "…and both writes must be in ONE function, or this case is testing the " +
        "cross-function bound again",
    );
  });

  it("a `docType` BELOW the write call does not bleed into the key", () => {
    // The other positional remnant. `docType` was read from a 1,200-character
    // forward window, which reaches well past the end of the call — so a
    // `docType:` literal in a LATER, unrelated statement was appended to the
    // key. At that point the key is no longer identity: it depends on what
    // happens to sit near the site, and an exemption moves when a neighbour
    // changes. It is now bounded by the call's own matching `)`.
    const src = [
      "async function storeUnnamed(): Promise<void> {",
      "  await prisma.stockDocument.upsert({ where: { id: doc.id } });",
      "  await publishDocumentIngest(doc.id);",
      '  await prisma.otherTable.update({ data: { docType: "annual_report" } });',
      "}",
    ].join("\n");

    assert.deepEqual(
      scanSource("f.ts", src).map((s) => s.key),
      ["f.ts:storeUnnamed:upsert"],
      "a docType from a statement AFTER the write call was folded into its key",
    );

    // The control: the old 1,200-character window did reach that literal.
    const at = src.indexOf("prisma.stockDocument.upsert");
    assert.match(
      src.slice(at, at + 1_200),
      /docType:\s*"annual_report"/,
      "the fixture no longer places the foreign docType inside the old window",
    );
  });

  it("[premise] every scanned file is brace- and paren-BALANCED", () => {
    // Both new bounds are brace/paren walks over RAW source, which is the same
    // assumption the enclosing-function walk has always made — if it were
    // unsound, every exemption KEY would already be wrong. A file that
    // desynchronises would compute the wrong function end, and the failure is
    // silent in one direction: a window running PAST the real closing brace is
    // the hole this ticket just closed, reopened.
    const unbalanced: string[] = [];
    let examined = 0;
    for (const root of ROOTS) {
      let entries: string[];
      try {
        entries = readdirSync(join(REPO_ROOT, root)).filter((f) =>
          f.endsWith(".ts"),
        );
      } catch {
        continue;
      }
      for (const f of entries) {
        const src = readFileSync(join(REPO_ROOT, root, f), "utf8");
        if (!new RegExp(WRITE_CALL.source).test(src)) continue;
        examined++;
        for (const [open, close] of [
          ["{", "}"],
          ["(", ")"],
        ] as const) {
          let depth = 0;
          let min = 0;
          for (const ch of src) {
            if (ch === open) depth++;
            else if (ch === close) {
              depth--;
              if (depth < min) min = depth;
            }
          }
          if (depth !== 0 || min < 0) {
            unbalanced.push(`${root}/${f} ${open}${close} (${depth}/${min})`);
          }
        }
      }
    }
    // A walk that reaches no files reports every file balanced — the vacuity
    // this whole suite exists to avoid, and this case re-walks the roots
    // independently of `scan()`, so it needs its own floor rather than leaning
    // on `[premise] the scan finds writers at all`.
    assert.ok(
      examined >= 6,
      `only ${examined} writer files examined — REPO_ROOT or ROOTS has drifted`,
    );
    assert.deepEqual(unbalanced, [], unbalanced.join("\n"));
  });

  it("[meta] the enclosing-function walk survives a TS return type and nested blocks", () => {
    // `): Promise<{ ok: boolean }> {` puts braces between the parameter list
    // and the body; an `if`/`try` around the write puts more braces between the
    // write and the header. Both resolve to the same function or the key is
    // decided by layout after all.
    const src = [
      "export async function storeNSEFiling(",
      "  doc: Doc,",
      "): Promise<{ ok: boolean; id: string }> {",
      "  if (doc.bytes.length > 0) {",
      "    try {",
      '      await prisma.stockDocument.upsert({ where: { docType: "annual_report" } });',
      "    } catch (err) {",
      "      log(err);",
      "    }",
      "  }",
      "  return { ok: true, id: doc.id };",
      "}",
    ].join("\n");
    assert.deepEqual(
      scanSource("f.ts", src).map((s) => s.key),
      ["f.ts:storeNSEFiling:upsert:annual_report"],
    );
  });
});
