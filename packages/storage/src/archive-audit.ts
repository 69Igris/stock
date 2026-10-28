/**
 * Read-only integrity classification for archived feed objects — MONEY-1204
 * (P14 / 14a.1), corrected by MONEY-1315 and again by MONEY-1323.
 *
 * `feed-repair.ts` already knows how to RECOVER a corrupted object. What it
 * could not do is answer the prior question — "is anything still corrupt, and
 * where?" — without downloading and attempting a repair on every object in the
 * bucket. This module is that question, split out as a pure function so it can
 * be unit-tested against real bytes and reused by a `--audit` mode that writes
 * nothing.
 *
 * ## Why it lives here and not in `@usemoney/core`
 *
 * It reuses {@link isMultipartEnvelope} directly rather than re-deriving the
 * boundary sniff. `packages/core` does not depend on `@usemoney/storage`, so
 * putting the classifier there would have meant either a new dependency edge or
 * — far worse — a SECOND implementation of envelope detection. Two copies of a
 * predicate that decides whether data is corrupt is exactly the drift this repo
 * has been bitten by before: the copies agree until the day they don't, and the
 * disagreement surfaces as an audit that reports "clean".
 *
 * ## Why it classifies from a HEAD, not the whole object
 *
 * Every verdict below is decidable from the first few hundred bytes plus the
 * object's declared size. That matters at this scale: measured 2026-09-01 on
 * `stockbook-content-prod`, `feeds/` is 325,086 objects and `stocks/` a further
 * 100,339, tens of GB between them. A full download per object would make the
 * audit expensive enough that nobody runs it, and an audit nobody runs is
 * indistinguishable from no audit.
 *
 * ## The verdicts, and why "empty" is separate from "invalid"
 *
 * A zero-byte object is NOT a corrupt object — it is a SUCCESSFUL write of
 * nothing, which is how a fetch failure gets recorded as a fact. It has to be
 * counted apart, because the remedy differs: an envelope is repairable in place
 * from the bytes we already hold, while a zero-byte object can only be fixed by
 * re-fetching from the exchange, which may no longer be possible. Collapsing the
 * two into one "bad" bucket is what turns a re-fetchable gap into a permanent
 * one, because the report says "repairable" for both.
 *
 * ## MONEY-1315 — why one `envelope` verdict was a CENSUS BUG
 *
 * The original classifier returned `envelope` the moment the OUTER bytes
 * matched the boundary sniff, and never looked inside. That made the whole
 * envelope population read as "repairable in place", and the 14a.1 census
 * headline said so: `envelope 1,076 (1.16%) REPAIRABLE`.
 *
 * It is not. `feed-repair --apply --prefixes=stocks/` ran to 30,000 objects and
 * reported `repaired=0 clean=29,666 failed=329`, which looked like a broken
 * repairer and was not — it was a wrongly-labelled population. Probing 60
 * envelope-detected objects under `stocks/` byte by byte:
 *
 *   59  payload is HTML
 *    1  pdf without %PDF magic at offset 0
 *    0  would-repair
 *
 * The corrected `--audit` over the whole tree agrees, 2026-09-01 on
 * `stockbook-content-prod`: of 100,339 objects, the 1,076 the old classifier
 * called REPAIRABLE are 1,046 `envelope-html` (97.2%), 25 `envelope-unknown`
 * (2.3%) and FIVE `envelope-data` (0.46%). The whole `--apply` job on `stocks/`
 * is five objects. `stocks/drhp` is the worst leg — 566 of its 694 objects are
 * enveloped SEBI pages and another 42 are bare ones, leaving 86 real documents.
 *
 * TWO defects are stacked in those objects. First, `stock-document-sync` stored
 * a SEBI landing/challenge page under a `.txt` DRHP or credit-rating key —
 * `stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt` holds
 * `<!DOCTYPE html>…<title>SEBI | AAA Technologies Limited - Prospectus</title>`.
 * Then MONEY-1169's broken upload path wrapped that page in a multipart
 * envelope. The envelope's own metadata part says so out loud —
 * `{"cacheControl":"private, max-age=3600","contentType":"text/html; charset=UTF-8"}`
 * — the writer KNEW it was storing HTML. Stripping the envelope yields an HTML
 * page, and `verifyPayload` refuses it CORRECTLY: `repaired=0` was right
 * behaviour on a wrongly-labelled population.
 *
 * So the envelope verdict is now decided by the PAYLOAD, not the wrapper:
 *
 *   `envelope-data`     the payload passes the same checks that gate `--apply`
 *                       AND the object fits the caller's repair ceiling.
 *                       Genuinely repairable in place, zero exchange traffic.
 *   `envelope-html`     the payload is an HTML page. NOT repairable — same
 *                       remedy as a bare `html` object: re-fetch or quarantine.
 *                       Running `--apply` over these writes nothing and is not
 *                       a failure of the repairer.
 *   `envelope-unknown`  the audit could not CERTIFY the payload from the head:
 *                       either it starts beyond the head window, or it was read
 *                       and fails the magic its own extension promises. Never
 *                       counted as repairable.
 *   `envelope-too-large` the payload is intact — this is an `envelope-data`
 *                       object in every respect except that the WHOLE OBJECT
 *                       exceeds `maxRepairBytes`, so the repair skips it before
 *                       the download. Repairable in principle, unreachable at
 *                       this ceiling. See MONEY-1323 below.
 *
 * `envelope-unknown` exists rather than folding into `envelope-data` because
 * "could not determine" must be a distinct value, never the optimistic default
 * — that default is the entire bug above, one layer down. It is also kept
 * inside the `envelope-*` family rather than folded into `invalid` so the
 * envelope CENSUS stays complete: "how many enveloped objects are there, and is
 * the broken writer still producing them" is a question about the wrapper, and
 * an answer that silently drops the ones we could not judge is the same
 * undercount in the other direction.
 *
 * The KIND is the remedy class; the `why` carries the diagnosis. That is how
 * `invalid` already worked (zip/pdf/json/workbook magic failures all share one
 * kind and differ in `why`).
 *
 * ## MONEY-1323 — the ceiling the classifier could not see
 *
 * MONEY-1315 left one divergence, and it is the consequential kind: the census
 * and the job it predicts disagreed while both were internally correct.
 * `feed-repair --apply --prefixes=stocks/` walked the whole corpus and reported
 * `repaired=0` against an audit saying FIVE objects were `envelope-data` — a
 * kind defined one screen up as "passes the same checks that gate `--apply`".
 *
 * Re-classified with sizes, measured 2026-09-02 on `stockbook-content-prod`,
 * all five are the same shape:
 *
 *   103.3 MB  stocks/ARHAM/concall_ppt/ARHAM-concall_ppt-Jun 2026.pdf
 *   152.7 MB  stocks/BTML/concall_ppt/BTML-concall_ppt-Dec 2022.pdf
 *   135.3 MB  stocks/HUDCO/annual_report/HUDCO-annual_report-FY2014.pdf
 *   212.0 MB  stocks/SHOPERSTOP/annual_report/SHOPERSTOP-annual_report-FY2014.pdf
 *   147.2 MB  stocks/SKP/announcement/SKP-announcement-2025.pdf
 *
 * Every one exceeds `--max-bytes` (default 100 MB). The repair tests
 * `size > MAX_BYTES` and `continue`s BEFORE the download, counting `tooLarge` —
 * so it never reaches bytes the census had already declared repairable. The
 * objects ARE recoverable: a re-run at `--max-bytes=250000000 --concurrency=1`
 * reported `repaired=3` and `too-large` left the reason tally entirely.
 *
 * The classifier could not express that, because it knew nothing about the
 * caller's ceiling — and it must NOT learn it from an ambient read. So the
 * ceiling is an ARGUMENT (`maxRepairBytes`), the function stays pure, and the
 * census gains a verdict that means what it says. `envelope-too-large` is a
 * REMEDY class of its own — "re-run with a larger ceiling and a smaller
 * concurrency", not "re-fetch" and not "needs eyes" — which is exactly why it
 * cannot fold into any of the three above.
 *
 * `maxRepairBytes` is OPTIONAL, and omitting it means "this caller has no
 * repair ceiling because it is not repairing", NOT "assume an unlimited
 * budget". `document-body-guard.ts` in `packages/research` is that caller: it
 * asks whether a stored document body is an HTML landing page, never whether
 * `--apply` could rewrite it, so a size-derived verdict would be noise there.
 *
 * ## MONEY-1320 — `html` was a false positive on three feeds
 *
 * Six objects under `feeds/RBI/nsdp-{rates,prices,forex}` audited as `html`,
 * which read as a dark feed archiving challenge pages. The premise was false:
 * prod archived them on schedule and the production parser reads 90/23/10 live
 * rows out of exactly those bytes. RBI's National Summary Data Page IS an HTML
 * table, `feed-payload.ts` calls these "the only feeds whose payload is
 * legitimately an HTML document", and this classifier never asked.
 *
 * It asks now, through {@link feedShapeFor} — the same `FEED_SHAPES` row the
 * write-time validator uses — so there is no second list of "families where
 * HTML is fine". See {@link familyDeclaresHtmlPayload} for why an unregistered
 * family can never acquire that licence by accident, and for what the exemption
 * deliberately does NOT claim.
 */

// MONEY-1320. The ONE declaration of what a feed's payload is supposed to be.
// `feedShapeFor` is a pure `FEED_SHAPES` lookup with a URL-derived fallback, so
// importing it keeps this module pure AND keeps the "is HTML legitimate here?"
// answer in exactly one place. `@usemoney/storage` already depends on
// `@usemoney/core` (core never imports storage — see feed-archive.ts:47), so
// this adds no dependency edge, only a module inside an existing one.
// Subpath, never the root barrel: `@usemoney/core/market-data` re-exports 155
// modules and pulls ~200 of them in (measured 211 ms) for the ONE lookup this
// file needs. `classifyArchivedObject` is called once per object across a
// 113,740-object walk, so the audit pays that import cost for nothing.
import { feedShapeFor } from "@usemoney/core/market-data/feed-payload";
import type { FeedDescriptor } from "@usemoney/core/market-data/feed-archive";

import {
  isMultipartEnvelope,
  stripMultipartEnvelope,
} from "./multipart-envelope";

/**
 * How many leading bytes {@link classifyArchivedObject} needs.
 *
 * MEASURED, MONEY-1315. The envelope preamble that has to be skipped before the
 * payload's first byte is
 *
 *   `--<uuid>\r\nContent-Type: application/json\r\n\r\n{META}\r\n`
 *   `--<uuid>\r\nContent-Type: <CT>\r\n\r\n`
 *
 * which for the writer's metadata shape (`cacheControl` + `contentType`, the
 * only two fields `uploadFile` sets when no caller passes extra) is exactly
 * `191 + 2 × len(contentType)` bytes. Across 121 envelope-bearing objects under
 * `stocks/` on `stockbook-content-prod` the payload offset was min 209
 * (`text/html`), p50/p95/max 239 (`text/html; charset=UTF-8`), with none
 * unresolved inside a 4,096-byte probe.
 *
 * 512 — the value 14a.1 shipped — does technically leave 273-303 payload bytes,
 * enough for a `<!doctype` or `%PDF` sniff. It is raised to 1,024 anyway
 * because that bound is NOT structural: the preamble grows linearly with the
 * declared content type (an OOXML type is 65 chars → 321 bytes), and
 * `uploadFile` splices arbitrary caller-supplied `metadata` into the same JSON
 * part, so a future writer can push the payload past 512 with no code change
 * here. At 1,024 the worst measured preamble still leaves 785 payload bytes.
 *
 * The cost of the extra 512 bytes is nil in practice: this is a single ranged
 * GET per object either way, and GCS bills the OPERATION. The audit is
 * latency-bound on round trips, not on bytes.
 */
export const ARCHIVE_AUDIT_HEAD_BYTES = 1024;

export type ArchiveVerdictKind =
  /** Positively verified for its extension, or plausibly text. */
  | "ok"
  /** size === 0. A successful write of nothing — re-fetch, cannot repair. */
  | "empty"
  /**
   * MONEY-1169 envelope wrapping a payload that passes its own checks.
   * Repairable in place from these bytes — this is the only repairable kind.
   */
  | "envelope-data"
  /**
   * MONEY-1169 envelope wrapping an HTML challenge/landing page. NOT
   * repairable: stripping it yields the wrong document. Re-fetch or quarantine.
   */
  | "envelope-html"
  /**
   * MONEY-1169 envelope whose payload the audit could not certify — it begins
   * past the head window, or it fails the magic its extension promises. Never
   * auto-repaired; needs eyes.
   */
  | "envelope-unknown"
  /**
   * MONEY-1323. An `envelope-data` object in every respect EXCEPT that the
   * whole object is larger than the caller's `maxRepairBytes`, so the repair
   * skips it before the download and can never reach it. Repairable in
   * principle, unreachable at this ceiling — raise `--max-bytes` (and let the
   * concurrency derivation lower the pool) and re-run.
   */
  | "envelope-too-large"
  /** An HTML challenge/error page stored as if it were data. Re-fetch. */
  | "html"
  /** Fails the magic-byte check its extension promises. */
  | "invalid";

/**
 * The `envelope-*` family — the MONEY-1169 wrapper, whatever is inside it.
 *
 * `envelope-too-large` belongs here for the same reason the other three do: the
 * family answers "how many enveloped objects are left, and is the broken writer
 * still producing them", which is a question about the WRAPPER. A size ceiling
 * is a property of the READER and cannot remove an object from that census.
 */
export const ENVELOPE_VERDICT_KINDS = [
  "envelope-data",
  "envelope-html",
  "envelope-unknown",
  "envelope-too-large",
] as const satisfies readonly ArchiveVerdictKind[];

/**
 * Is this verdict about a MONEY-1169 envelope, regardless of its payload?
 *
 * Callers asking "how many enveloped objects are left" and "is the broken
 * writer still running" want the whole family, not just the repairable slice.
 */
export function isEnvelopeVerdictKind(kind: ArchiveVerdictKind): boolean {
  return (ENVELOPE_VERDICT_KINDS as readonly string[]).includes(kind);
}

export interface ArchiveVerdict {
  kind: ArchiveVerdictKind;
  /** Human-readable reason. Empty for `ok`. */
  why: string;
}

const OK: ArchiveVerdict = { kind: "ok", why: "" };
const OK_PAYLOAD: PayloadVerdict = { kind: "ok", code: "", why: "" };

/**
 * Does this buffer begin with an HTML (or XSL-styled) document?
 *
 * ONE implementation, deliberately. NSE and BSE both answer a throttled or
 * cookieless request with a 200 carrying an HTML challenge page, and SEBI
 * answers a document request with a landing page; stored under a `.csv` or
 * `.txt` key that is not a malformed CSV, it is the WRONG DOCUMENT — and a
 * parser reading it reports "0 rows", which looks like a market holiday.
 *
 * The same predicate has to judge a bare object AND the payload inside an
 * envelope. A second copy for the inner case is exactly the drift this module's
 * header warns about: the copies agree until the day they don't.
 */
function looksLikeHtml(bytes: Buffer): boolean {
  const text = bytes.subarray(0, 64).toString("latin1").trimStart();
  return /^<(!doctype|html|\?xml-stylesheet)/i.test(text);
}

/**
 * Is HTML the DECLARED payload for this object's feed family? — MONEY-1320.
 *
 * ## The false positive, and why the premise it was filed on was wrong
 *
 * The `--audit` flagged six objects under `feeds/RBI/nsdp-{rates,prices,forex}`
 * as `html`, and that read as a dark feed storing challenge pages. It is not.
 * Measured on prod: the objects were archived 2026-09-01 02:30:01 UTC (08:00
 * IST Tue) by `macro-sync-midweek`, prod's own egress fetched RBI successfully,
 * and running the PRODUCTION parser over exactly those archived bytes yields
 * rates 90 rows / 15 series, prices 23/8, forex 10/10, all FRESH, release stamp
 * 2026-08-28, against 274 live rows in `macro_series`.
 *
 * RBI's National Summary Data Page IS an HTML table. `feed-payload.ts` says so
 * in as many words — "the only feeds whose payload is legitimately an HTML
 * document" — and validates them on `class="tablebg"`. This classifier simply
 * never asked.
 *
 * ## Why it asks `feedShapeFor` instead of keeping a list
 *
 * A local set of "families where HTML is fine" would be a SECOND declaration of
 * a fact `FEED_SHAPES` already owns, which is the drift this module's header
 * warns about and the same defect MONEY-1323 removed one function down.
 * `archiveFamilyOf` already returns `RBI/nsdp-rates` — the exact string that
 * indexes `FEED_SHAPES` — so the lookup needs no new plumbing and no registry
 * change.
 *
 * The empty URL is deliberate and SAFE BY CONSTRUCTION, not by luck: it forces
 * `feedShapeFor` past its registered row into `shapeFromUrl("")`, whose whole
 * codomain is `zip | csv | json | xml | unknown`. It can never return `html`,
 * so an UNREGISTERED family cannot acquire an HTML licence from the fallback —
 * which is the direction that would turn a fixed false positive into a blind
 * spot. Pinned by a test.
 *
 * ## What this does NOT claim
 *
 * It says "HTML here is not evidence of corruption", never "this HTML is the
 * right page". Those RBI pages bury `class="tablebg"` ~40-49 KB in, and this
 * classifier reads {@link ARCHIVE_AUDIT_HEAD_BYTES} = 1,024 — so the token
 * check is structurally out of reach here and re-deriving it would mark every
 * legitimate RBI object `invalid`. That check lives at the WRITE, in
 * `validateFeedPayload`, which refuses to archive a page without it; a
 * challenge page therefore cannot reach the archive through `getFeedAsset` in
 * the first place. Stated rather than hidden.
 */
function familyDeclaresHtmlPayload(key: string): boolean {
  // `feeds/` only. `stocks/<doc-type>` shares the `X/Y` family shape but is not
  // a feed family and can never carry a `FEED_SHAPES` row; gating on the prefix
  // means a future publisher or document type named alike cannot collide.
  if (!key.startsWith("feeds/")) return false;

  const family = archiveFamilyOf(key);
  const slash = family.indexOf("/");
  if (slash <= 0) return false;

  // The cast is contained and cannot mislead: `FEED_SHAPES` is indexed by a
  // plain string, so a publisher outside the declared union simply misses the
  // row and falls to the fallback above.
  const exchange = family.slice(0, slash) as FeedDescriptor["exchange"];
  const feed = family.slice(slash + 1);
  return feedShapeFor({ exchange, feed }, "").kind === "html";
}

/**
 * The narrow set of outcomes a payload can have on its own merits.
 *
 * `code` is a LOW-CARDINALITY reason id, not prose. It exists because
 * `feed-repair`'s streaming reason tally buckets failures by code and prints
 * `html=253 pdf-magic=1` — a tally keyed on `why` would grow one bucket per
 * distinct sentence. Empty string for `ok`.
 */
export interface PayloadVerdict {
  kind: "ok" | "html" | "invalid";
  code: string;
  why: string;
}

/**
 * Classify PAYLOAD bytes — the part of the check that is identical whether the
 * bytes came straight off the object or out of an envelope.
 *
 * ## MONEY-1323 — this is now THE predicate, and `feed-repair` calls it
 *
 * `feed-repair.ts` carried its own `verifyPayload` with a second copy of these
 * rules, and the copies had drifted in exactly the way this module's header
 * warns about — silently, and in the direction that makes the census read
 * BETTER than reality:
 *
 *   - `looksLikeHtml` here matches `<?xml-stylesheet`; the copy matched only
 *     `<!doctype|html`.
 *   - here `.xls` / `.xlsx` and `.xml` have magic branches; the copy had
 *     neither.
 *
 * So `envelope-unknown` claimed "repair would refuse it" for payloads the
 * repair would have accepted, and `envelope-data` was not "the same checks that
 * gate `--apply`" for an XSL-styled page. The fix is not a third rule — it is
 * ONE function with two callers. `verifyPayload` keeps only what is genuinely
 * its own (empty-after-strip, still-an-envelope: both properties of the STRIP,
 * not of the payload) and delegates the rest here.
 *
 * `empty` is not among the outcomes: a zero-length object is decided by the
 * declared SIZE, one level up, and a zero-length payload inside an envelope is
 * a structural failure of the envelope rather than a property of the payload.
 *
 * `declaredContentType` is the envelope's own `Content-Type`, and it is a
 * LAST-RESORT corroborator, never the primary signal — metadata can lie, and in
 * this population it demonstrably does the opposite of lying (the SEBI pages
 * are stamped `text/html` under a `.txt` key, so the wrapper is honest and the
 * KEY is the fiction). It is consulted only where the key's extension supplies
 * no positive rule at all, which is the `stocks/<SYM>/annual_report/...`
 * extensionless shape, and it exists so this census predicts what
 * `feed-repair`'s `verifyPayload` will actually do rather than something
 * adjacent to it. Bare (unwrapped) objects pass `undefined` and are judged
 * exactly as before.
 */
export function classifyPayloadBytes(
  key: string,
  bytes: Buffer,
  declaredContentType?: string,
): PayloadVerdict {
  // Checked before the per-extension branches: a `.csv` key holding a challenge
  // page is not a malformed CSV, it is a different document entirely.
  //
  // MONEY-1320: unless HTML is what this family's payload IS. The exemption
  // lives HERE, in the shared predicate, rather than in `classifyArchivedObject`
  // — put it one level up and `feed-repair`'s `verifyPayload` (which calls this
  // function directly) would go on refusing a legitimate RBI page, re-opening
  // the census-vs-repair divergence MONEY-1323 just closed.
  if (looksLikeHtml(bytes)) {
    if (familyDeclaresHtmlPayload(key)) return OK_PAYLOAD;
    return {
      kind: "html",
      code: "html",
      why: "HTML where data was expected — almost certainly an archived challenge/error page",
    };
  }

  const lower = key.toLowerCase();
  const text = bytes.subarray(0, 64).toString("latin1").trimStart();

  if (lower.endsWith(".zip")) {
    return bytes[0] === 0x50 && bytes[1] === 0x4b
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          code: "zip-magic",
          why: "zip without PK magic at offset 0",
        };
  }
  if (lower.endsWith(".pdf")) {
    return bytes.subarray(0, 4).toString("latin1") === "%PDF"
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          code: "pdf-magic",
          why: "pdf without %PDF magic at offset 0",
        };
  }
  if (lower.endsWith(".json")) {
    const first = text[0];
    return first === "{" || first === "["
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          code: "json-magic",
          why: "json not starting { or [",
        };
  }
  if (lower.endsWith(".xml")) {
    return text.startsWith("<")
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          code: "xml-magic",
          why: "xml not starting with <",
        };
  }
  if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
    // Two legal containers: BIFF8/OLE2 (0xD0CF11E0) for .xls, and a zip for
    // .xlsx. NSE serves genuine BIFF8 for fii_stats, so accepting only the zip
    // form would flag every one of 1,636 good objects.
    const ole2 =
      bytes[0] === 0xd0 &&
      bytes[1] === 0xcf &&
      bytes[2] === 0x11 &&
      bytes[3] === 0xe0;
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    return ole2 || zip
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          code: "workbook-magic",
          why: "workbook with neither OLE2 nor zip magic",
        };
  }

  // No extension rule applied. If the envelope declared a type with a magic of
  // its own, hold the payload to it — this is the only place the declared type
  // is allowed to decide anything, and it can only ever make the verdict
  // STRICTER, never wave a payload through.
  const ct = (declaredContentType ?? "").toLowerCase();
  if (ct.includes("pdf")) {
    return bytes.subarray(0, 4).toString("latin1") === "%PDF"
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          // Same CODE as the extension branch on purpose: the reason tally
          // buckets by remedy ("this is not a PDF"), and where we learned to
          // expect a PDF belongs in `why`, not in a second bucket.
          code: "pdf-magic",
          why: "declared pdf without %PDF magic at offset 0",
        };
  }
  if (ct.includes("zip")) {
    return bytes[0] === 0x50 && bytes[1] === 0x4b
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          code: "zip-magic",
          why: "declared zip without PK magic at offset 0",
        };
  }
  if (ct.includes("json")) {
    const first = text[0];
    return first === "{" || first === "["
      ? OK_PAYLOAD
      : {
          kind: "invalid",
          code: "json-magic",
          why: "declared json not starting { or [",
        };
  }

  // csv / dat / lst / txt / extensionless. There is no positive magic to check,
  // so "not empty, not an envelope, not HTML" is the strongest true statement
  // available. Claiming more would be a precise rule with no catch-all, which
  // shrinks coverage the moment a new feed format appears.
  return OK_PAYLOAD;
}

/**
 * Classify one archived object from its key, declared size and leading bytes.
 *
 * Pure and synchronous: no I/O, no clock, no randomness. That property is
 * load-bearing — it is what lets the whole classifier be pinned against real
 * captured bytes in a unit test, and what lets the audit call it 92,000 times
 * without a second network hop. MONEY-1315 kept it: looking INSIDE the envelope
 * uses the head bytes the caller already read, never a second fetch.
 *
 * `head` may be shorter than {@link ARCHIVE_AUDIT_HEAD_BYTES} (a genuinely
 * small object) — that is not itself a fault.
 *
 * Order is deliberate. `empty` first, because a zero-length buffer trivially
 * fails every magic-byte check and would otherwise be reported as `invalid`,
 * sending a responder to repair bytes that do not exist. The envelope branch
 * second, because an enveloped object's head is the BOUNDARY, not the payload,
 * so every type check below would misfire on it.
 *
 * ## `maxRepairBytes` — the caller's ceiling, passed IN (MONEY-1323)
 *
 * The repair skips any object larger than its `--max-bytes` BEFORE downloading
 * it, so a census that ignores size promises work the job will not do — five
 * objects' worth, measured; see the module header. The ceiling is therefore an
 * argument and never an ambient read: purity is what lets this be pinned
 * against captured bytes, and an `process.env` lookup in here would make the
 * verdict depend on where it was evaluated.
 *
 * It is applied ONLY on the branch that would otherwise return `envelope-data`.
 * Size does not change the remedy for the other two: an oversized
 * `envelope-html` still needs a re-fetch and an oversized `envelope-unknown`
 * still needs eyes, so relabelling either by size would hide a real diagnosis
 * behind an operational one.
 *
 * Omitted (or non-finite) means the CALLER HAS NO REPAIR CEILING because it is
 * not repairing — not "assume an unlimited budget". `document-body-guard.ts`
 * is that caller.
 */
export function classifyArchivedObject(args: {
  key: string;
  size: number;
  head: Buffer;
  /** The caller's repair ceiling in bytes. Omit if the caller never repairs. */
  maxRepairBytes?: number;
}): ArchiveVerdict {
  const { key, size, head, maxRepairBytes } = args;

  if (size === 0) {
    return {
      kind: "empty",
      why: "zero bytes — a successful write of nothing; re-fetch required, not repairable",
    };
  }

  if (isMultipartEnvelope(head)) {
    // Peel with the REAL repairer, not a second parser: whatever `--apply`
    // would recover is what the census must grade. On a truncated head this
    // returns null when the media part's blank line has not arrived yet, which
    // is precisely the "payload starts beyond the window" signal.
    const stripped = stripMultipartEnvelope(head);
    if (!stripped || stripped.payload.length === 0) {
      return {
        kind: "envelope-unknown",
        why:
          `MONEY-1169 envelope whose payload does not begin within the first ` +
          `${ARCHIVE_AUDIT_HEAD_BYTES} bytes — undetermined, NOT counted as ` +
          `repairable; re-read this key with a larger head to judge it`,
      };
    }

    const inner = classifyPayloadBytes(
      key,
      stripped.payload,
      stripped.contentType,
    );
    if (inner.kind === "html") {
      return {
        kind: "envelope-html",
        why:
          `MONEY-1169 envelope wrapping an HTML page (declared ` +
          `${stripped.contentType ?? "no content-type"}) — NOT repairable: ` +
          `stripping it yields the wrong document. Re-fetch or quarantine`,
      };
    }
    if (inner.kind === "invalid") {
      return {
        kind: "envelope-unknown",
        why:
          `MONEY-1169 envelope wrapping a payload that fails its extension's ` +
          `promise (${inner.why}) — repair would refuse it; needs eyes`,
      };
    }
    // The payload is intact. The only remaining question is whether the caller
    // can actually reach it — `feed-repair` tests `size > MAX_BYTES` and
    // `continue`s BEFORE the download, so an object over the ceiling is counted
    // `tooLarge` and never repaired however good its payload is.
    if (
      typeof maxRepairBytes === "number" &&
      Number.isFinite(maxRepairBytes) &&
      size > maxRepairBytes
    ) {
      return {
        kind: "envelope-too-large",
        why:
          `MONEY-1169 envelope over intact data, but the object is ${size}B ` +
          `> the ${maxRepairBytes}B repair ceiling — the repair skips it ` +
          `before the download, so this is NOT work \`--apply\` will do at ` +
          `this --max-bytes. Recoverable: raise --max-bytes and re-run ` +
          `(the concurrency derivation shrinks the pool to match)`,
      };
    }
    return {
      kind: "envelope-data",
      why: "MONEY-1169 multipart upload envelope over intact data — repairable in place from these bytes",
    };
  }

  const bare = classifyPayloadBytes(key, head);
  return bare.kind === "ok" ? OK : { kind: bare.kind, why: bare.why };
}

/**
 * Per-family tallies, keyed by the `feeds/{exchange}/{feed}` prefix.
 *
 * Extends `Record<ArchiveVerdictKind, number>` on purpose: adding a verdict
 * kind without adding its counter is then a COMPILE error in
 * {@link emptyFamilyAudit}, so a new kind can never be silently dropped from
 * the census — which is how the MONEY-1315 mislabel would have survived a
 * partial fix.
 */
export interface ArchiveFamilyAudit extends Record<ArchiveVerdictKind, number> {
  family: string;
  scanned: number;
  /** A bounded sample of offending keys, for the report. */
  examples: Array<{ key: string; kind: ArchiveVerdictKind; why: string }>;
}

/**
 * Derive the family label from an archive key.
 *
 * Two grammars, because the bucket holds two trees:
 *
 *   `feeds/NSE/fii-stats/2026/08/x.xls`      → `NSE/fii-stats`
 *   `stocks/RELIANCE/drhp/RELIANCE-IPO.txt`  → `stocks/drhp`
 *
 * MONEY-1315 added the second. Without it every one of the 99,853 objects
 * under `stocks/` fell into `(unrecognised)`, so the per-family table — the
 * whole point of the audit — collapsed to ONE row and the sample cap showed
 * five example keys for the entire tree. The census was correct and unreadable,
 * which is the same as unusable: it could not say WHICH scraper leg was storing
 * challenge pages.
 *
 * The `stocks/` label keys on the DOCUMENT TYPE, not the symbol. Symbol-major
 * would be ~2,400 single-digit rows nobody can scan, while the document type is
 * the axis a responder acts on: it names the scraper leg (`drhp`,
 * `credit_rating`, `annual_report`) that needs re-fetching.
 *
 * Anything matching neither grammar is bucketed under `(unrecognised)` rather
 * than silently dropped — an object that does not fit any key grammar is itself
 * a finding.
 */
export function archiveFamilyOf(key: string): string {
  const parts = key.split("/");
  if (parts.length < 4) return "(unrecognised)";
  if (parts[0] === "feeds") return `${parts[1]}/${parts[2]}`;
  if (parts[0] === "stocks") return `stocks/${parts[2]}`;
  return "(unrecognised)";
}

/** Fold a verdict into a family tally, capping the retained examples. */
export function recordArchiveVerdict(
  tally: ArchiveFamilyAudit,
  key: string,
  verdict: ArchiveVerdict,
  maxExamples = 5,
): void {
  tally.scanned++;
  tally[verdict.kind]++;
  if (verdict.kind !== "ok" && tally.examples.length < maxExamples) {
    tally.examples.push({ key, kind: verdict.kind, why: verdict.why });
  }
}

export function emptyFamilyAudit(family: string): ArchiveFamilyAudit {
  return {
    family,
    scanned: 0,
    ok: 0,
    empty: 0,
    "envelope-data": 0,
    "envelope-html": 0,
    "envelope-unknown": 0,
    "envelope-too-large": 0,
    html: 0,
    invalid: 0,
    examples: [],
  };
}
