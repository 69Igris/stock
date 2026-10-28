/**
 * Quarantine the `stock_documents` rows whose GCS object is an HTML page
 * (MONEY-1315 part B)
 * ==========================================================================
 *
 * ## What is wrong
 *
 * Under the `stocks/` prefix there are objects whose bytes are a SEBI landing
 * page stored where a document was expected. Verbatim, from prod 2026-08-31:
 *
 *     KEY   stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt
 *     meta  {"cacheControl":"private, max-age=3600",
 *            "contentType":"text/html; charset=UTF-8"}
 *     body  <!DOCTYPE html><html lang="en">…
 *           <title>SEBI | AAA Technologies Limited - Prospectus</title>
 *
 * Screener's Documents section links a DRHP to SEBI's HTML *landing page* for
 * the issue rather than to the prospectus PDF, and the rating-agency links
 * behave the same way. The fetch returns 200 with an honest `text/html` header,
 * so there is no transport failure and nothing to alarm on. Measured on prod
 * the same day, over 88,607 rows:
 *
 *     mimeType         status        rows
 *     text/html        UNSUPPORTED   1,580     ← this population
 *       of which  credit_rating  841  SCREENER
 *                 drhp           608  SCREENER
 *
 * `initialProcessingStatus` (MONEY-1255) already caught the STATUS — all 1,580
 * are correctly `UNSUPPORTED`. What it never did was stop the WRITE, so every
 * one of them still carries a `gcsPath`, and `gcsPath` is the column every
 * reader takes as proof the bytes are there. A row that claims a document it
 * does not have is worse than an absent row: nothing distinguishes it from a
 * real one except opening the bytes.
 *
 * ## WHAT A FULL DRY RUN AGAINST PROD FOUND — 2026-09-01
 *
 *     scanned            88,607 rows / 99,308 objects under stocks/
 *     html (QUARANTINE)   1,573      envelope:html 1,046 · bare html 527
 *     ga                 80,038
 *     objectMissing           0
 *     alreadyQuarantined  6,996
 *
 * ## RE-RUN 2026-09-02, AFTER THE SHORT-PAGE BREAK WAS REMOVED — AND IT
 * ## RECONCILES NOW
 *
 *     scanned            90,213 rows / 123,131 objects under stocks/
 *     html (QUARANTINE)   1,062
 *     htmlIsTheDocument     511      KEPT (MONEY-1321)
 *     ok                 81,558
 *     objectMissing           0
 *     alreadyQuarantined  7,082
 *     distinct objects    1,062      0 shared with a KEPT row
 *
 *     RECOVERABLE-FIRST GUARD   790  SEBI 604 · ICRA 186   -> --apply REFUSED
 *
 * `alreadyQuarantined` is 7,082 and this same run's own absent-field census
 * reports `gcsPath === "" 7,082` — EXACTLY equal, on the same pass. The
 * 6,996-vs-7,234 gap the section below was written about is closed: it was the
 * short-page `break` ending the walk early, as suspected, and the numbers now
 * agree to the row. Quote 7,082 (2026-09-02), not 6,996 and not 7,234.
 *
 * **AND THE GUARD IS NOT HYPOTHETICAL.** 790 of the 1,062 rows this migration
 * would clear are rows `recover-html-stock-documents.ts` can still turn into a
 * real document from the very bytes about to be blanked. Running `--apply`
 * today is refused, and before MONEY-1321 H2 it would have destroyed all 790
 * while printing a clean census and exiting 0.
 *
 * ## THAT 6,996 DOES NOT RECONCILE, and the line here used to claim it did
 *
 * It read "== the gcsPath:"" census, exactly". It is not. On the SAME DAY,
 * `docs/reference/doc-ingest-population.md` counted **7,234** empty-`gcsPath`
 * rows within the **79,884** PDF rows alone — a SUBSET of the 88,607 scanned
 * here, which cannot contain more of them than the whole. Both cannot be right.
 *
 * The likeliest cause is in this file and is fixed below: the page loop used to
 * `break` when a batch came back shorter than `PAGE_SIZE`, and
 * `$runCommandRaw`'s `cursor.firstBatch` is capped at 16 MB REGARDLESS of the
 * requested `batchSize`. One short page ends the walk, and every total printed
 * afterwards is a confident number over a population the scan stopped reading —
 * the MONEY-1189 `firstBatch`-truncation class. 88,607 is therefore a FLOOR,
 * not a census, and so is every figure beside it.
 *
 * Re-run this dry run after the fix before quoting any of these numbers again.
 * `7,234` is the figure the rest of the repo uses, and it is the one to trust
 * until then — CLAUDE.md's older `6,125` (measured 2026-08-29) is superseded by
 * it, not in conflict with it: the population GREW.
 *
 *     credit_rating  832   drhp  608   concall_ppt  64
 *     annual_report   39   concall_transcript  30
 *
 * EVERY one is `sourceType: "SCREENER"` — `annual-reports-sync`,
 * `nse-announcements-sync` and `bse-announcements-sync` produced ZERO, so the
 * whole population came through `storeScreenerDoc`.
 *
 * ## The header disagrees with the bytes in BOTH DIRECTIONS, 13 times
 *
 * This is the number that justifies opening the objects at all, and a
 * `mimeType`-keyed migration would have got every one of them wrong:
 *
 *     3 rows stored `application/pdf` and hold an HTML page.
 *       2 `concall_ppt` + 1 `annual_report`, all SCREENER. A header-keyed
 *       selection CLEARS them, and they stay PENDING in a 44,912-deep
 *       extraction queue against bytes no extractor can read.
 *
 *    10 rows stored `text/html` and hold something that is NOT an HTML page.
 *       9 `credit_rating` + 1 `concall_transcript`. A header-keyed selection
 *       CONDEMNS them — it would blank the `gcsPath` of ten documents we
 *       actually hold, with `sourceUrl` the only way back.
 *
 * (1,580 `text/html` rows − 10 = 1,570; + 3 = the 1,573 above.)
 *
 * The 38 `annual_report` rows are the shape worth remembering: their
 * `sourceUrl` ENDS IN `.pdf`
 * (`bseindia.com/bseplus/AnnualReport/543766/74205590122.pdf`) and BSE served
 * an interstitial page from it. The URL, the extension and the header can all
 * say PDF while the bytes say otherwise.
 *
 * ## MONEY-1321 — 520 OF THOSE ROWS MUST NOT BE TOUCHED, AND WERE
 *
 * This file described all 1,573 as ready to quarantine. Measuring the pages
 * corrected it. Across the full HTML-bodied cohort on prod 2026-09-02, by the
 * host of `sourceUrl`:
 *
 *     host                     rows  with bytes  verdict
 *     www.sebi.gov.in           616         605  landing page — the PDF is one hop on
 *     www.crisil.com            495         442  THE PAGE IS THE DOCUMENT
 *     www.icra.in               196         186  viewer page — one hop on
 *     www.indiaratings.co.in    146         135  JS shell — unrecoverable
 *     www.bseindia.com           74          74  BSE homepage — unrecoverable
 *     bcrisp.in                  69          69  THE PAGE IS THE DOCUMENT
 *     connect.acuite.in           9           9  THE PAGE IS THE DOCUMENT
 *     (61 company IR hosts)      61          61  unrecoverable
 *
 * 520 rows (442 + 69 + 9) are credit-rating RATIONALES published as the page:
 * median extracted text 17,177 / 13,201 / 18,288 characters, against 455 for a
 * SEBI landing page and 86 for an India Ratings shell. CRISIL's own `sourceUrl`
 * ENDS IN `.html`; there was never a PDF to fetch instead. Blanking their
 * `gcsPath` would destroy content we hold, and nothing revisits a cleared row.
 *
 * They are therefore classified `htmlIsTheDocument` and NEVER enter
 * `quarantineIds`. The exclusion is STRUCTURAL, not a filter: ids are pushed
 * only inside the `html` branch, so a row the classifier does not call `html`
 * cannot reach the write at all. The host list is `isHtmlTheDocumentHost`'s —
 * the same one the recovery router reads — so the two can never disagree about
 * which pages are safe to clear.
 *
 * `scripts/migrations/recover-html-stock-documents.ts` is what those rows are FOR: it
 * extracts their text in place, and fetches the real document for the 790
 * SEBI/ICRA rows this migration still quarantines.
 *
 * ## RUN THE RECOVERY FIRST. This file used to say order does not matter.
 *
 * The claim was that "the recovery reads `gcsPath` when it is set and falls
 * back to re-fetching `sourceUrl` when the quarantine has already blanked it".
 * **There was no such fallback** (MONEY-1321 H2). The recovery returned
 * `noBytes` on an empty body, and its ONE fetch derives its URL from the PAGE —
 * so quarantine-first would have blanked 604 SEBI + 186 ICRA `gcsPath`s, every
 * one would have classified `noBytes`, the census would have read clean, the
 * run would have exited 0, and the content would have been unrecoverable.
 *
 * Two things changed, and only one of them is a sentence:
 *
 *   - ICRA no longer needs bytes — its rationale id is the `Id` parameter of
 *     `sourceUrl`, so the recovery derives the PDF URL from the row alone. SEBI
 *     cannot: its viewer link lives in the page.
 *   - **This migration now REFUSES `--apply`** while any row it would clear is
 *     one the recovery could still save from the bytes about to be destroyed.
 *     It asks `recoveryStillNeedsTheseBytes` — the recovery's own router over
 *     the row's own page — so the dangerous order is unreachable rather than
 *     documented, and the guard lifts itself once the recovery has run (a
 *     recovered row's bytes are a PDF, so it classifies `ok` and never reaches
 *     the branch). There is no override flag; a comment is not a guard, and
 *     neither is a promise.
 *
 * ## The remedy, and what it deliberately keeps
 *
 * `gcsPath: ""` plus a terminal `processingStatus`, and `fileSize: 0` with it —
 * a byte count beside an absent path is a claim about a document that is not
 * there, and `doc-convert.ts` sizes its OOM refusal off exactly that column.
 *
 * The empty string is this repo's established "the bytes are not there"
 * convention rather than a new one — **7,234** rows already carry it (measured
 * 2026-09-01 across the 79,884 PDF rows, `docs/reference/doc-ingest-population.md`)
 * because BSE stops serving corpfiling attachments below ~2018 — and every
 * reader skips it BY NAME (`gcsPath: { notIn: [""] }`,
 * `doc-ingest-selectors-logic.ts:129` and `:180`,
 * `doc-ingest-backfill.ts:1314`).
 *
 * `sourceUrl`, `title`, `description`, `symbol`, `docType` and `period` are
 * KEPT, on the same precedent that CLAUDE.md states for those BSE rows: "they
 * are NOT corrupt … metadata, title, description and `sourceUrl` are all
 * present, which is the useful part". The citation still resolves and a later
 * pass can re-fetch from `sourceUrl` if SEBI ever serves a PDF there.
 *
 * Both values are imported from `document-body-guard.ts` — the same module the
 * WRITER's refusal path imports them from — so the migration and the writer
 * cannot leave a row in two different states.
 *
 * ## Why the bytes have to be opened, and how little of them
 *
 * There is no column that distinguishes these rows. `mimeType: "text/html"` is
 * a good proxy for the 1,580 known ones, but it is a proxy: it is written from
 * the response HEADER, and the whole finding is that the header is not the
 * bytes. Four writers in this repo used to HARDCODE `application/pdf` at the
 * upload (`storeNSEFiling`, `annual-reports-sync`, `nse-announcements-sync`,
 * `stock-document-fetcher`), so for them a stored `application/pdf` was our own
 * claim, not the upstream's — and the scan below found three rows where exactly
 * that is false. MONEY-1319 replaced those literals with a media type derived
 * from the BYTES, which fixes the SOURCE; it does not change this scan, because
 * every row already in the table was written under the old rule.
 *
 * So every object is classified from a RANGED READ of its first 2 KB
 * (`DOCUMENT_SNIFF_HEAD_BYTES`) — never a download. The prefix holds 99,308
 * objects and hundreds of GB; a full download per object would make this a job
 * nobody runs, and a migration nobody runs is indistinguishable from no
 * migration. Sizes come from ONE listing pass over the `stocks/` prefix (~100
 * API calls at 1,000 per page) rather than a `getMetadata` per object, which
 * halves the calls and makes "the object is not there at all" free to detect.
 *
 * The classification itself is `sniffDocumentBody`, which is
 * `classifyArchivedObject` from `@usemoney/storage` plus one thing that module
 * cannot do alone: look INSIDE a MONEY-1169 multipart envelope. That matters
 * here more than anywhere — 1,046 of the 1,573 are ENVELOPED — because the
 * classifier checks for the envelope first (it must; an enveloped object's head
 * is the boundary) and therefore answers an `envelope-*` kind, never `html`,
 * for that majority. No second copy of the HTML predicate is written anywhere.
 *
 * ## The absent-field trap, and why the selection avoids it entirely
 *
 * A Mongo `prisma db push` creates INDEXES, never FIELDS. A Prisma equality or
 * `{ not: … }` filter on an attribute that is ABSENT matches ZERO rows in BOTH
 * directions, and this class has caused MONEY-1050, 1205, 1234, 1235 and 1236.
 * `gcsPath` is a REQUIRED column, which makes it *look* immune — it is not:
 * this branch's own history includes 785,352 rows written by pymongo, which
 * applies no Prisma defaults, and Prisma cannot even READ a row whose required
 * attribute is absent.
 *
 * So the selection filters on NO possibly-absent field at all. It walks the
 * whole collection through `$runCommandRaw` with `$ifNull` projections, keyed
 * by `_id` ascending, and decides in CODE. A row with no `gcsPath` attribute
 * is therefore visible and counted (`noGcsPath`) rather than silently outside
 * the query. The one optional narrowing, `--doc-type`, is on a required column
 * that every row carries.
 *
 * The VERIFICATION uses different semantics from the selection by construction:
 * the selection's predicate is "these BYTES are HTML", which is not a database
 * predicate and cannot be re-run as one. The post-write check is a raw
 * `$exists`-aware census over the ids we wrote — a verify that re-ran the
 * selection could only ever confirm the selection's own blind spot, which is
 * exactly how three sibling migrations printed a confident zero for months
 * (scripts/README.md, MONEY-1236).
 *
 * ## Deleting the objects is SEPARATE and OFF
 *
 * `--delete-objects` is a second, independent flag. Clearing `gcsPath` makes
 * the rows honest immediately and is reversible from the archive; deleting the
 * bytes is not reversible at all. They are also different questions: the 30-day
 * feed-archive rules do not cover `stocks/`, and someone may still want to
 * re-derive which SEBI page was served. Deletion is keyed by DISTINCT object,
 * and an object is only deleted when EVERY row pointing at it is being
 * quarantined — several `(symbol, exchange, docType, period)` rows can share
 * one `gcsPath`, because the path is derived from symbol/docType/period and
 * carries no exchange.
 *
 * That last property used to hold "by construction, because the verdict is
 * cached PER KEY". MONEY-1321 ended it: `classifyDocumentRow` reads the row's
 * OWN `sourceUrl`, so two rows over identical bytes can split into `html` and
 * `htmlIsTheDocument`. It is now ENFORCED — a key any KEPT row still points at
 * is withheld from the delete set and reported. Measured on prod 2026-09-02: 11
 * shared `gcsPath`s, none currently mixing a kept host with a cleared one.
 *
 * ## Idempotent
 *
 * Re-running finds the already-quarantined rows carrying `gcsPath: ""`, skips
 * them before any GCS call (`alreadyQuarantined`), and reports nothing to do.
 *
 * ## Which environment
 *
 * Run it on **prod**. `stock_documents` is in `sync-prod-to-qa.sh`'s
 * `REFERENCE_COLLECTIONS`, so QA receives the corrected rows by copy and a QA
 * run would be undone by the next restore. `--env qa` still works for a
 * rehearsal.
 *
 * Usage (dry run prints the full census and writes nothing):
 *   npx tsx scripts/migrations/quarantine-html-stock-documents.ts --env prod
 *   npx tsx scripts/migrations/quarantine-html-stock-documents.ts --env prod --apply
 *   npx tsx scripts/migrations/quarantine-html-stock-documents.ts --env prod --apply --delete-objects
 *
 * Flags:
 *   --apply           actually write (default: DRY RUN). Needs a TTY.
 *   --delete-objects  additionally delete the GCS objects. Default OFF.
 *                     Only meaningful with --apply.
 *   --env qa|prod     read DATABASE_URL + the bucket name for that environment
 *   --doc-type T      restrict to one docType (e.g. drhp). Dry-run sampling.
 *   --limit N         stop after N rows scanned. Dry-run only.
 */

import { execFileSync } from "child_process";
import readline from "readline";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// The REAL production decision, imported rather than restated — the same module
// the writer's refusal path uses, so a quarantined row and a refused download
// end in the identical state. NARROW subpaths: `document-body-guard` reaches
// only the two pure leaves in `@usemoney/storage`, so nothing here loads the
// GCS SDK by importing it (this file loads it explicitly, below).
import {
  sniffDocumentBody,
  classifyDocumentRow,
  recoveryStillNeedsTheseBytes,
  recoveryLaneNeedsTheBody,
  DOCUMENT_SNIFF_HEAD_BYTES,
  HTML_QUARANTINE_STATUS,
  ABSENT_GCS_PATH,
  type DocumentRowClass,
} from "@usemoney/research/data-sources/document-body-guard";
// Peeled before the recovery router sees the page: 1,046 of the 1,573 HTML
// bodies are MONEY-1169 envelopes, and a router handed the envelope preamble
// finds no `<iframe>` and would report every one of them as nothing to save.
// A pure leaf — importing it loads no GCS SDK.
import { stripMultipartEnvelope } from "@usemoney/storage/multipart-envelope";

dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/** `StockDocument.@@map`. */
const COLLECTION = "stock_documents";

/** The prefix every stock document lives under. */
const STOCKS_PREFIX = "stocks/";

/** Rows per raw aggregate page while walking the collection. */
const PAGE_SIZE = 5000;

/**
 * Concurrent ranged reads against GCS.
 *
 * The bound exists so a whole-corpus dry run cannot open ~82,000 sockets at
 * once. 32 keeps the wall clock at a few minutes without giving the bucket a
 * burst it would throttle.
 */
const READ_CONCURRENCY = 32;

/** Ids per raw `update` command. Keeps one command's filter document bounded. */
const WRITE_CHUNK = 500;

/**
 * Ceiling on the FULL page read the MONEY-1321 H2 guard performs.
 *
 * Rating and landing pages measure 10-30 KB; 8 MB is far above anything in the
 * population and exists so a pathological object cannot stall the scan.
 */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

interface Options {
  apply: boolean;
  deleteObjects: boolean;
  env: "qa" | "prod" | null;
  docType: string | null;
  limit: number | null;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored:
 * `argv.includes()` silently drops what it does not recognise, which is how a
 * sibling script came to accept-and-ignore `--dry-run` alongside `--apply`
 * (i.e. it WROTE).
 */
const KNOWN_FLAGS = new Set([
  "--apply",
  "--delete-objects",
  "--env",
  "--doc-type",
  "--limit",
]);

function assertKnownFlags(argv: string[]): void {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}.`,
    );
  }
  const eq = argv.filter((a) => /^--[a-z-]+=/.test(a));
  if (eq.length > 0) {
    throw new Error(
      `Use "--flag value", not "${eq[0]}". The equals form is not parsed, and an ` +
        `unparsed --env would leave APPLY mode pointed at the ambient DATABASE_URL.`,
    );
  }
}

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);
  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${f} was given with no value`);
    }
    return next;
  };

  const env = val("--env");
  if (env && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}"`);
  }

  const limitRaw = val("--limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
    }
    limit = n;
  }

  const apply = has("--apply");

  // A sampled census beside a whole-table write is the shape where the only
  // output an operator can judge the change by describes something else.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: the census would describe a " +
        "sample while the write covers the corpus. Use --limit for the dry run.",
    );
  }
  if (apply && val("--doc-type") !== null) {
    throw new Error(
      "--doc-type cannot be combined with --apply: the finding spans docTypes " +
        "and a narrowed write leaves the rest claiming documents they do not " +
        "have. Use --doc-type for the dry run.",
    );
  }
  if (has("--delete-objects") && !apply) {
    throw new Error(
      "--delete-objects is meaningless without --apply: a dry run deletes " +
        "nothing. It is refused rather than ignored, so nobody can believe a " +
        "dry run reported what a deletion would do.",
    );
  }
  // Fail FAST, before reading 88,000 rows. `--apply` on a closed stdin can
  // never succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as
  // success (the MONEY-1252 shape).
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt cannot " +
        "be answered when stdin is not a TTY (a pipe, </dev/null, or a CI runner).",
    );
  }

  return {
    apply,
    deleteObjects: has("--delete-objects"),
    env: (env as "qa" | "prod" | null) ?? null,
    docType: val("--doc-type"),
    limit,
  };
}

/** Fetch a secret from Secret Manager, mirroring scripts/seed-env.sh. */
function secret(name: string): string {
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${name}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${name} from Secret Manager`);
  return out;
}

/** Host of a Mongo URI, for display. Never prints any credential. */
function maskedHost(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.host || null;
  } catch {
    const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, "");
    const authority = withoutScheme.split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return host.trim() || null;
  }
}

/* -------------------------------------------------------------------------- */
/* The census                                                                  */
/* -------------------------------------------------------------------------- */

/** One row, as the raw aggregate hands it over. */
interface DocRow {
  id: string;
  symbol: string;
  docType: string;
  exchange: string;
  gcsPath: string | null;
  /**
   * The page this row was fetched FROM — MONEY-1321.
   *
   * Selected because it is what separates a landing page from a document. 520
   * of the HTML-bodied rows are rating rationales published AS the page
   * (CRISIL 442, Brickwork 69, Acuité 9), and their host is the only column
   * that says so. `$ifNull`-projected like the rest: absent arrives as null.
   */
  sourceUrl: string | null;
  mimeType: string | null;
  processingStatus: string | null;
}

/**
 * What we decided about one row. The decision itself is
 * {@link classifyDocumentRow}, in `document-body-guard.ts`, so it is reachable
 * by a unit test without a DATABASE_URL and a bucket.
 */
type RowClass = DocumentRowClass;

interface Census {
  scanned: number;
  byClass: Record<RowClass, number>;
  /** `docType → RowClass → n`. The per-class breakdown a total cannot give. */
  byDocType: Map<string, Record<RowClass, number>>;
  /** `sniff.kind → n` over the HTML rows: bare vs enveloped. */
  byHtmlKind: Map<string, number>;
  /** `mimeType → n` over the HTML rows. Shows which headers lied. */
  byHtmlMime: Map<string, number>;
  /** Row ids to quarantine. */
  quarantineIds: string[];
  /** Distinct object keys behind those ids. */
  quarantineKeys: Set<string>;
  /**
   * Distinct object keys a KEPT row still points at — MONEY-1321 M5.
   *
   * `--delete-objects` may not remove any of these, whatever else points at
   * them. See the deletion block for the invariant this now enforces rather
   * than assumes.
   */
  keptKeys: Set<string>;
  /**
   * Rows the RECOVERY could still turn into a document — MONEY-1321 H2.
   *
   * Non-empty means the destructive job is about to run BEFORE the constructive
   * one, and `--apply` is refused. Recorded with the host so the refusal names
   * what is at stake rather than a bare count.
   */
  recoverable: Array<{ id: string; host: string; url: string }>;
  examples: string[];
}

function emptyClasses(): Record<RowClass, number> {
  return {
    alreadyQuarantined: 0,
    objectMissing: 0,
    htmlIsTheDocument: 0,
    html: 0,
    ok: 0,
  };
}

function newCensus(): Census {
  return {
    scanned: 0,
    byClass: emptyClasses(),
    byDocType: new Map(),
    byHtmlKind: new Map(),
    byHtmlMime: new Map(),
    quarantineIds: [],
    quarantineKeys: new Set(),
    keptKeys: new Set(),
    recoverable: [],
    examples: [],
  };
}

function record(census: Census, row: DocRow, cls: RowClass): void {
  census.scanned++;
  census.byClass[cls]++;
  let per = census.byDocType.get(row.docType);
  if (!per) {
    per = emptyClasses();
    census.byDocType.set(row.docType, per);
  }
  per[cls]++;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Host of a `sourceUrl`, for the H2 refusal's per-host breakdown. */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "(unparseable)";
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((res) =>
    rl.question(question, (a) => res(a)),
  );
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.env) {
    process.env.DATABASE_URL = secret(
      opts.env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD",
    );
    process.env.GCP_PROJECT_ID ??= GCP_PROJECT;
    process.env.GCP_STORAGE_BUCKET = `stockbook-content-${opts.env === "qa" ? "qa" : "prod"}`;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set (pass --env qa|prod).");
  }
  const bucketName = process.env.GCP_STORAGE_BUCKET;
  if (!bucketName) {
    throw new Error("GCP_STORAGE_BUCKET is not set (pass --env qa|prod).");
  }

  // Imported AFTER `--env` has resolved DATABASE_URL: `@usemoney/database`
  // builds its PrismaClient at module scope from `process.env.DATABASE_URL`, so
  // a top-level import would pin the client to the ambient value.
  const { PrismaClient } = await import("@usemoney/database");
  const { Storage } = await import("@google-cloud/storage");

  const prisma = new PrismaClient();
  const bucket = new Storage({
    projectId: process.env.GCP_PROJECT_ID ?? GCP_PROJECT,
  }).bucket(bucketName);

  console.log(
    `\n${opts.apply ? "APPLY" : "DRY RUN"} — quarantine HTML stock_documents\n` +
      `  database ${maskedHost(dbUrl) ?? "(unparseable)"}\n` +
      `  bucket   ${bucketName}\n` +
      `  objects  ${opts.deleteObjects ? "WILL BE DELETED" : "kept (use --delete-objects to remove)"}` +
      (opts.docType ? `\n  docType  ${opts.docType}` : "") +
      (opts.limit ? `\n  limit    ${opts.limit} row(s)` : "") +
      "\n",
  );

  try {
    /* -- 0. The absent-field census, printed before anything relies on it. -- */
    //
    // Not decoration. It answers, for THIS collection in THIS environment,
    // whether the trap that has caused MONEY-1050/1205/1234/1235/1236 is even
    // live here — and it is the only way to know, because a Prisma count with
    // the same intent would return the same zero whether the field is absent on
    // no rows or on all of them.
    const absent = (await prisma.$runCommandRaw({
      aggregate: COLLECTION,
      pipeline: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            noGcsPathAttr: {
              $sum: {
                $cond: [{ $eq: [{ $type: "$gcsPath" }, "missing"] }, 1, 0],
              },
            },
            emptyGcsPath: {
              $sum: { $cond: [{ $eq: ["$gcsPath", ""] }, 1, 0] },
            },
            noStatusAttr: {
              $sum: {
                $cond: [
                  { $eq: [{ $type: "$processingStatus" }, "missing"] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ],
      cursor: {},
    })) as {
      cursor: {
        firstBatch: Array<{
          total: number;
          noGcsPathAttr: number;
          emptyGcsPath: number;
          noStatusAttr: number;
        }>;
      };
    };
    const a = absent.cursor.firstBatch[0];
    if (!a) {
      // `aggregate` against a collection that does not exist returns an EMPTY
      // result rather than an error, so a future `@@map()` rename would
      // otherwise turn every count below into a hard-coded zero.
      throw new Error(
        `aggregate over "${COLLECTION}" returned no groups — the collection is ` +
          `empty or the @@map name has changed. Refusing to report a zero.`,
      );
    }
    console.log(
      `ABSENT-FIELD CENSUS (\$type "missing", not a Prisma null filter)\n` +
        `  rows total                 ${a.total}\n` +
        `  gcsPath attribute ABSENT   ${a.noGcsPathAttr}\n` +
        `  gcsPath === ""             ${a.emptyGcsPath}\n` +
        `  processingStatus ABSENT    ${a.noStatusAttr}\n`,
    );

    /* -- 1. One listing pass: every object under stocks/, name -> size. ---- */
    console.log(`Listing ${bucketName}/${STOCKS_PREFIX} …`);
    const sizes = new Map<string, number>();
    let pageToken: string | undefined;
    do {
      const [files, , resp] = (await bucket.getFiles({
        prefix: STOCKS_PREFIX,
        maxResults: 1000,
        autoPaginate: false,
        ...(pageToken ? { pageToken } : {}),
      })) as unknown as [
        Array<{ name: string; metadata: { size?: string | number } }>,
        unknown,
        { nextPageToken?: string } | undefined,
      ];
      for (const f of files) sizes.set(f.name, Number(f.metadata.size ?? 0));
      pageToken = resp?.nextPageToken;
      if (sizes.size % 20000 < 1000) {
        console.log(`  … ${sizes.size} objects listed`);
      }
    } while (pageToken);
    console.log(`  ${sizes.size} objects under ${STOCKS_PREFIX}\n`);

    if (sizes.size === 0) {
      // `listFiles` in @usemoney/storage FAILS OPEN to `[]`, and this pass uses
      // the SDK directly for the same reason it must not fail open here: an
      // auth or bucket failure that reads as "no objects" would classify every
      // row as `objectMissing`, report a clean run, and quarantine nothing —
      // or, one flag over, propose deleting nothing while claiming success.
      throw new Error(
        `No objects found under ${bucketName}/${STOCKS_PREFIX}. That is an ` +
          `auth/bucket failure, not an empty prefix — refusing to proceed.`,
      );
    }

    /* -- 2. Walk the collection, classify from a ranged head read. --------- */
    const census = newCensus();
    let lastId: string | null = null;

    // Read the bytes for one key. Never a full download: `end` is inclusive, so
    // this asks for exactly DOCUMENT_SNIFF_HEAD_BYTES.
    const readHead = async (key: string, size: number): Promise<Buffer> => {
      if (size === 0) return Buffer.alloc(0);
      const chunks: Buffer[] = [];
      await new Promise<void>((res, rej) => {
        bucket
          .file(key)
          .createReadStream({
            start: 0,
            end: Math.min(size, DOCUMENT_SNIFF_HEAD_BYTES) - 1,
          })
          .on("data", (c: Buffer) => chunks.push(c))
          .on("error", rej)
          .on("end", () => res());
      });
      return Buffer.concat(chunks);
    };

    /**
     * Read a WHOLE object — only for the rows the H2 guard has to judge.
     *
     * The 2 KB head above cannot answer "would the recovery still save this?":
     * SEBI's viewer `<iframe>` sits well past it, so a head-only guard would
     * report every SEBI row as nothing-to-save and wave through the exact
     * destruction it exists to prevent. This runs for quarantine-bound rows on
     * a ONE-HOP host only — ~790 pages of 10-30 KB, once per distinct key.
     *
     * A read failure returns `null`, which the caller treats as UNKNOWN and
     * therefore as "still needed": on a one-way door the safe answer to "we
     * could not check" is to refuse, never to proceed.
     */
    const readFullPage = async (
      key: string,
      size: number,
    ): Promise<Buffer | null> => {
      if (size === 0) return Buffer.alloc(0);
      try {
        const [raw] = await bucket
          .file(key)
          .download({ start: 0, end: Math.min(size, MAX_PAGE_BYTES) - 1 });
        const buf = Buffer.from(raw);
        const stripped = stripMultipartEnvelope(buf);
        return stripped ? Buffer.from(stripped.payload) : buf;
      } catch {
        return null;
      }
    };

    // Distinct-object cache. Several `(symbol, exchange, docType, period)` rows
    // can share one `gcsPath` — the path is derived from symbol/docType/period
    // and carries NO exchange, so a dual-listed company's NSE and BSE rows are
    // the same object. Classifying per distinct key rather than per row is both
    // cheaper and the thing that makes `--delete-objects` safe.
    const verdicts = new Map<string, { html: boolean; kind: string }>();

    /**
     * The FULL page for one key, decoded, cached per DISTINCT key.
     *
     * `null` means the read failed and the guard must treat the row as
     * still-recoverable. Cached alongside `verdicts` and for the same reason:
     * several rows share one object.
     */
    const pages = new Map<string, string | null>();
    const pageFor = async (key: string): Promise<string | null> => {
      if (pages.has(key)) return pages.get(key)!;
      const buf = await readFullPage(key, sizes.get(key) ?? 0);
      const text = buf === null ? null : buf.toString("utf-8");
      pages.set(key, text);
      return text;
    };

    for (;;) {
      const page = (await prisma.$runCommandRaw({
        aggregate: COLLECTION,
        pipeline: [
          ...(lastId ? [{ $match: { _id: { $gt: { $oid: lastId } } } }] : []),
          ...(opts.docType ? [{ $match: { docType: opts.docType } }] : []),
          { $sort: { _id: 1 } },
          { $limit: PAGE_SIZE },
          {
            $project: {
              // `$ifNull` everywhere a value might be ABSENT rather than null.
              // This projection is the whole reason the selection cannot fall
              // into the trap: a row with no `gcsPath` attribute arrives as
              // null and is COUNTED, instead of being filtered out by a
              // predicate that silently matches nothing.
              symbol: { $ifNull: ["$symbol", ""] },
              docType: { $ifNull: ["$docType", "(absent)"] },
              exchange: { $ifNull: ["$exchange", ""] },
              gcsPath: { $ifNull: ["$gcsPath", null] },
              sourceUrl: { $ifNull: ["$sourceUrl", null] },
              mimeType: { $ifNull: ["$mimeType", null] },
              processingStatus: { $ifNull: ["$processingStatus", null] },
            },
          },
        ],
        cursor: { batchSize: PAGE_SIZE },
      })) as {
        cursor: {
          firstBatch: Array<
            Omit<DocRow, "id"> & { _id: { $oid: string } | string }
          >;
        };
      };

      const batch = page.cursor.firstBatch;
      if (batch.length === 0) break;

      const rows: DocRow[] = batch.map((r) => ({
        id: typeof r._id === "string" ? r._id : r._id.$oid,
        symbol: r.symbol,
        docType: r.docType,
        exchange: r.exchange,
        gcsPath: r.gcsPath,
        sourceUrl: r.sourceUrl,
        mimeType: r.mimeType,
        processingStatus: r.processingStatus,
      }));
      lastId = rows[rows.length - 1]!.id;

      // Rows that need no GCS call at all, decided first so an already-migrated
      // corpus costs zero requests on a re-run.
      const needBytes: DocRow[] = [];
      for (const row of rows) {
        // `bodyIsHtml: false` is a placeholder here — the two classes this
        // pass can settle (`alreadyQuarantined`, `objectMissing`) are decided
        // before any byte is read, and anything else falls through to the
        // second call below with a real verdict.
        const pre = classifyDocumentRow({
          gcsPath: row.gcsPath,
          sourceUrl: row.sourceUrl,
          objectExists: row.gcsPath ? sizes.has(row.gcsPath) : false,
          bodyIsHtml: false,
        });
        if (pre !== "ok") {
          record(census, row, pre);
          continue;
        }
        needBytes.push(row);
      }

      // Classify the distinct keys this page introduced, bounded-concurrently.
      const fresh = [
        ...new Set(
          needBytes.map((r) => r.gcsPath!).filter((k) => !verdicts.has(k)),
        ),
      ];
      for (let i = 0; i < fresh.length; i += READ_CONCURRENCY) {
        const slice = fresh.slice(i, i + READ_CONCURRENCY);
        await Promise.all(
          slice.map(async (key) => {
            const size = sizes.get(key) ?? 0;
            const head = await readHead(key, size);
            const sniff = sniffDocumentBody({ key, size, head });
            verdicts.set(key, { html: sniff.html, kind: sniff.kind });
          }),
        );
      }

      for (const row of needBytes) {
        const v = verdicts.get(row.gcsPath!)!;
        const cls = classifyDocumentRow({
          gcsPath: row.gcsPath,
          sourceUrl: row.sourceUrl,
          objectExists: true,
          bodyIsHtml: v.html,
        });
        // MONEY-1321 — `htmlIsTheDocument` lands here and is recorded like any
        // other non-quarantine class, so it is COUNTED and never queued. The
        // exclusion is structural rather than a filter applied later: the ids
        // are only pushed inside the `html` branch, so a row this classifier
        // does not call `html` cannot reach `quarantineIds` at all.
        if (cls !== "html") {
          record(census, row, cls);
          // MONEY-1321 M5 — this row KEEPS its object, so nothing may delete
          // it. Recorded per KEY because several rows share one.
          census.keptKeys.add(row.gcsPath!);
          continue;
        }
        record(census, row, "html");
        bump(census.byHtmlKind, v.kind);
        bump(census.byHtmlMime, row.mimeType ?? "(absent)");
        census.quarantineIds.push(row.id);
        census.quarantineKeys.add(row.gcsPath!);
        if (census.examples.length < 8) {
          census.examples.push(
            `${row.docType.padEnd(18)} ${v.kind.padEnd(20)} ${row.gcsPath}`,
          );
        }

        // MONEY-1321 H2 — THE ORDER GUARD.
        //
        // These bytes may be the ONLY copy of the link to the real document.
        // The narrowing is the router's own lane, so no host list is restated
        // here and a host that gains a one-hop rule is covered the day it does.
        if (!recoveryLaneNeedsTheBody(row.sourceUrl)) continue;
        const page = await pageFor(row.gcsPath!);
        if (
          page === null ||
          recoveryStillNeedsTheseBytes({
            sourceUrl: row.sourceUrl,
            html: page,
          })
        ) {
          census.recoverable.push({
            id: row.id,
            host: row.sourceUrl ? hostOfUrl(row.sourceUrl) : "(none)",
            url: row.sourceUrl ?? "(no sourceUrl)",
          });
        }
      }

      console.log(
        `  scanned ${census.scanned}  html ${census.byClass.html}  ` +
          `htmlIsDoc ${census.byClass.htmlIsTheDocument}  ` +
          `ok ${census.byClass.ok}  missing ${census.byClass.objectMissing}  ` +
          `already ${census.byClass.alreadyQuarantined}`,
      );

      if (opts.limit !== null && census.scanned >= opts.limit) break;
      // THE SHORT-PAGE BREAK IS GONE — MONEY-1189's `firstBatch` class.
      //
      // `$runCommandRaw` returns `cursor.firstBatch`, which MongoDB caps at
      // 16 MB REGARDLESS of the requested `batchSize`. So a short page does not
      // mean "the collection is exhausted", it means "the wire limit was hit
      // first" — and treating the two as the same silently ends the walk with
      // most of the table unread, while every total printed below reads as a
      // complete census. That is what makes this class expensive: it does not
      // fail, it manufactures a confident wrong number (and see the
      // 6,996-vs-7,234 note in this file's header — that gap is exactly this
      // shape).
      //
      // Nothing is lost by dropping it: the keyset above advances on `lastId`
      // and the pipeline is `$sort: { _id: 1 }` + `$limit`, so an EMPTY batch is
      // the only true end-of-collection signal — and `batch.length === 0`
      // already breaks, four lines up from where this used to be. The cost of
      // removal is at most one extra empty round trip per run.
    }

    /* -- 3. Report, per class and per docType. ---------------------------- */
    console.log("\n=== CENSUS ===");
    console.log(`  scanned              ${census.scanned}`);
    console.log(`  html (QUARANTINE)    ${census.byClass.html}`);
    console.log(
      `  htmlIsTheDocument    ${census.byClass.htmlIsTheDocument}   ` +
        `(KEPT — the page IS the rationale; MONEY-1321 recovers these)`,
    );
    console.log(`  ok                   ${census.byClass.ok}`);
    console.log(`  objectMissing        ${census.byClass.objectMissing}`);
    console.log(`  alreadyQuarantined   ${census.byClass.alreadyQuarantined}`);
    console.log(`  distinct objects     ${census.quarantineKeys.size}`);
    // MONEY-1321 M5 — a key a KEPT row still points at can never be deleted.
    // Printed at zero too: the number an operator needs is "how many are
    // shared", and a line that appears only when non-zero cannot say "none".
    console.log(
      `  …shared with a KEPT row  ` +
        `${[...census.quarantineKeys].filter((k) => census.keptKeys.has(k)).length}` +
        `   (withheld from --delete-objects)`,
    );

    console.log("\n=== PER docType (html / ok / missing / already) ===");
    for (const [docType, per] of [...census.byDocType.entries()].sort(
      (x, y) => y[1].html - x[1].html,
    )) {
      console.log(
        `  ${docType.padEnd(24)} ${String(per.html).padStart(6)} ` +
          `${String(per.ok).padStart(7)} ${String(per.objectMissing).padStart(8)} ` +
          `${String(per.alreadyQuarantined).padStart(8)}`,
      );
    }

    console.log("\n=== HTML rows by verdict kind (bare vs enveloped) ===");
    for (const [kind, n] of [...census.byHtmlKind.entries()].sort(
      (x, y) => y[1] - x[1],
    )) {
      console.log(`  ${kind.padEnd(30)} ${n}`);
    }

    console.log("\n=== HTML rows by STORED mimeType (which headers lied) ===");
    for (const [mime, n] of [...census.byHtmlMime.entries()].sort(
      (x, y) => y[1] - x[1],
    )) {
      console.log(`  ${mime.padEnd(30)} ${n}`);
    }

    if (census.examples.length > 0) {
      console.log("\n=== examples ===");
      for (const e of census.examples) console.log(`  ${e}`);
    }

    /* -- 3b. THE ORDER GUARD — MONEY-1321 H2. ----------------------------- */
    //
    // Printed at ZERO as well, so an operator has been told the check ran. A
    // line that only appears on failure is indistinguishable from one a refactor
    // dropped.
    console.log("\n=== RECOVERABLE-FIRST GUARD (MONEY-1321 H2) ===");
    console.log(
      `  rows the recovery could still save   ${census.recoverable.length}`,
    );
    if (census.recoverable.length > 0) {
      const byHost = new Map<string, number>();
      for (const r of census.recoverable) bump(byHost, r.host);
      for (const [host, n] of [...byHost.entries()].sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`    ${host.padEnd(26)} ${n}`);
      }
      for (const r of census.recoverable.slice(0, 5)) {
        console.log(`    e.g. ${r.url}`);
      }
    }

    if (census.quarantineIds.length === 0) {
      console.log("\nNothing to quarantine.");
      return;
    }

    if (opts.apply && census.recoverable.length > 0) {
      // REFUSED, not warned. Blanking `gcsPath` destroys the only copy of the
      // link these rows are recovered through, and nothing revisits a cleared
      // row — so the dangerous order has to be UNREACHABLE rather than
      // documented. There is deliberately no override flag: the guard lifts
      // itself, because a recovered row's bytes are a PDF and never reach this
      // branch again.
      throw new Error(
        `REFUSING to quarantine: ${census.recoverable.length} of the ` +
          `${census.quarantineIds.length} row(s) still hold the only bytes ` +
          `scripts/migrations/recover-html-stock-documents.ts needs to fetch ` +
          `their real document. Blanking gcsPath now makes them unrecoverable ` +
          `and the census would still read clean.\n` +
          `  Run the recovery FIRST:\n` +
          `    node --import tsx scripts/migrations/recover-html-stock-documents.ts ` +
          `--env ${opts.env ?? "prod"} --apply\n` +
          `  then re-run this migration. Nothing has been written.`,
      );
    }

    if (!opts.apply) {
      // NAMES EVERY COLUMN THE WRITE TOUCHES, `fileSize` included. An operator
      // judges an un-run migration by this one line, and it used to list two of
      // the three fields the `$set` actually carries — so the third arrived as
      // a surprise on the run that could not be inspected any more. `fileSize`
      // is not cosmetic: `doc-convert.ts` sizes its OOM refusal ceiling from it
      // (peak RSS is 2.3-4.8x file size), so a stale byte count beside an empty
      // `gcsPath` is a document budget for bytes that are not there.
      console.log(
        `\nDRY RUN — would set gcsPath: "", fileSize: 0 and processingStatus: ` +
          `"${HTML_QUARANTINE_STATUS}" on ${census.quarantineIds.length} row(s), ` +
          `keeping sourceUrl / title / description.\n` +
          `Re-run with --apply to write.`,
      );
      return;
    }

    /* -- 4. Confirm, then write. ------------------------------------------ */
    //
    // The prompt quotes the count that will ACTUALLY be deleted, not the
    // quarantined-key count: a key a kept row still points at is withheld
    // (MONEY-1321 M5), and an operator approving a number larger than the act
    // has approved something that did not happen.
    const sharedKeys = [...census.quarantineKeys].filter((k) =>
      census.keptKeys.has(k),
    );
    const deletableKeys = [...census.quarantineKeys].filter(
      (k) => !census.keptKeys.has(k),
    );
    const ok = await confirm(
      `\nQuarantine ${census.quarantineIds.length} row(s) on ` +
        `${maskedHost(dbUrl)}${opts.deleteObjects ? ` AND DELETE ${deletableKeys.length} object(s)` + (sharedKeys.length > 0 ? ` (${sharedKeys.length} withheld — a kept row points at them)` : "") : ""}? ` +
        `Type "yes": `,
    );
    if (!ok) {
      console.log("Aborted; nothing written.");
      return;
    }

    let written = 0;
    for (let i = 0; i < census.quarantineIds.length; i += WRITE_CHUNK) {
      const chunk = census.quarantineIds.slice(i, i + WRITE_CHUNK);
      // Raw, not `prisma.updateMany`, for the same reason the READ is raw:
      // Prisma's Mongo connector cannot deserialise a row whose required
      // attribute is absent, and a write must not be limited to the rows the
      // client happens to be able to read.
      const res = (await prisma.$runCommandRaw({
        update: COLLECTION,
        updates: [
          {
            q: { _id: { $in: chunk.map((id) => ({ $oid: id })) } },
            u: {
              $set: {
                gcsPath: ABSENT_GCS_PATH,
                processingStatus: HTML_QUARANTINE_STATUS,
                fileSize: 0,
              },
            },
            multi: true,
          },
        ],
      })) as { nModified?: number; n?: number };
      written += res.nModified ?? 0;
      console.log(
        `  wrote ${Math.min(i + WRITE_CHUNK, census.quarantineIds.length)}/${census.quarantineIds.length}`,
      );
    }
    console.log(`\nUpdated ${written} row(s).`);

    /* -- 5. Verify with DIFFERENT semantics from the selection. ------------ */
    //
    // The selection's predicate was "these BYTES are HTML" — not a database
    // predicate, so it cannot be re-run as one and this check cannot confirm
    // its own blind spot (the MONEY-1236 shape). What it asserts instead is
    // that the write LANDED and did not do something adjacent-but-wrong:
    // `$exists: false` would mean we UNSET the column rather than emptying it,
    // which reads identically through Prisma and breaks every
    // `gcsPath: { notIn: [""] }` reader in the opposite direction.
    const check = (await prisma.$runCommandRaw({
      aggregate: COLLECTION,
      pipeline: [
        {
          $match: {
            _id: { $in: census.quarantineIds.map((id) => ({ $oid: id })) },
          },
        },
        {
          $group: {
            _id: null,
            seen: { $sum: 1 },
            stillPointing: {
              $sum: { $cond: [{ $ne: ["$gcsPath", ABSENT_GCS_PATH] }, 1, 0] },
            },
            unset: {
              $sum: {
                $cond: [{ $eq: [{ $type: "$gcsPath" }, "missing"] }, 1, 0],
              },
            },
            wrongStatus: {
              $sum: {
                $cond: [
                  { $ne: ["$processingStatus", HTML_QUARANTINE_STATUS] },
                  1,
                  0,
                ],
              },
            },
            lostSourceUrl: {
              $sum: {
                $cond: [{ $eq: [{ $type: "$sourceUrl" }, "missing"] }, 1, 0],
              },
            },
          },
        },
      ],
      cursor: {},
    })) as {
      cursor: {
        firstBatch: Array<{
          seen: number;
          stillPointing: number;
          unset: number;
          wrongStatus: number;
          lostSourceUrl: number;
        }>;
      };
    };
    const v = check.cursor.firstBatch[0];
    console.log(
      "\n=== VERIFY (raw $type/$exists, not the selection's rule) ===",
    );
    if (!v) {
      console.log(
        "  no rows returned — INVESTIGATE, the ids should still exist",
      );
    } else {
      console.log(
        `  ids re-read              ${v.seen}/${census.quarantineIds.length}`,
      );
      console.log(`  still pointing at bytes  ${v.stillPointing}  (want 0)`);
      console.log(`  gcsPath UNSET not ""     ${v.unset}  (want 0)`);
      console.log(`  status not terminal      ${v.wrongStatus}  (want 0)`);
      console.log(
        `  sourceUrl lost           ${v.lostSourceUrl}  (want 0 — it is kept)`,
      );
    }

    /* -- 6. Optional, separate: delete the objects. ------------------------ */
    if (opts.deleteObjects) {
      // NO OBJECT IS DELETED WHILE A ROW STILL POINTS AT IT.
      //
      // Several `(symbol, exchange, docType, period)` rows can share one
      // `gcsPath` — the path is derived from symbol/docType/period and carries
      // NO exchange, so a dual-listed company's NSE and BSE rows are the same
      // object.
      //
      // THIS USED TO SAY THE INVARIANT HELD BY CONSTRUCTION, "because the
      // verdict is cached PER KEY, so every row sharing a key gets the
      // identical class". MONEY-1321 ended that: `classifyDocumentRow` now
      // takes the row's OWN `sourceUrl`, so two rows over identical bytes can
      // land on different classes — one `html`, its sibling
      // `htmlIsTheDocument`. Deleting the object then strands a row we
      // deliberately kept, pointing at bytes that are gone. Measured on prod
      // 2026-09-02: 11 shared `gcsPath`s, none currently mixing a kept host
      // with a cleared one — LATENT, and the comment was already false.
      //
      // So the invariant is now ENFORCED rather than assumed: a key any KEPT
      // row still points at is withheld, and the count is reported.
      //
      // What could ALSO break it is a NARROWED scan — `--doc-type` or `--limit`
      // would let one row of a shared key be classified while its sibling is
      // never looked at, so `keptKeys` would not even know about the sibling.
      // Both are already refused alongside `--apply` in `parseArgs`; this
      // restates the reason at the point where the irreversible act happens,
      // because that refusal is four hundred lines away and its removal would
      // not look like it touched deletion.
      if (opts.docType !== null || opts.limit !== null) {
        throw new Error(
          "refusing to delete objects from a NARROWED scan: a row sharing a " +
            "gcsPath outside the narrowing would be left pointing at deleted bytes",
        );
      }
      if (sharedKeys.length > 0) {
        console.log(
          `\n${sharedKeys.length} object(s) are WITHHELD from deletion — a row ` +
            `we KEPT still points at each:`,
        );
        for (const k of sharedKeys.slice(0, 20)) console.log(`  kept: ${k}`);
      }
      const keys = deletableKeys;
      console.log(`\nDeleting ${keys.length} object(s) …`);
      let deleted = 0;
      for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
        await Promise.all(
          keys.slice(i, i + READ_CONCURRENCY).map(async (key) => {
            try {
              await bucket.file(key).delete();
              deleted++;
            } catch (err) {
              const code = (err as { code?: number }).code;
              // Already gone is a no-op, not a failure.
              if (code !== 404) throw err;
            }
          }),
        );
      }
      console.log(`Deleted ${deleted} object(s).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
