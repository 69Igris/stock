/**
 * MONEY-1314 — lane routing.
 *
 * The property this file exists to protect: THE TWO LANES DO NOT COVER EACH
 * OTHER. Markdown cannot read a scan; vision refuses anything over 50 MB, and
 * our largest document is 222.3 MB. So there are documents no lane can read,
 * and the routing must say so out loud instead of producing a mysterious
 * per-document failure that a forced run then repeats forever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideIngestLane,
  classifyIngestOutcome,
  splitPageMarkedMarkdown,
  exceedsVisionCeiling,
  hasUsableTextLayer,
  INGEST_PARSE_STATUS,
  TERMINAL_PARSE_STATUSES,
  isVisionArmed,
  DOC_VISION_APPLY_ENV,
} from "../../src/processors/stock-document-ingest-logic";
import { MAX_PDF_BYTES } from "../../src/lib/gemini-pdf";
import { SWEEPABLE_PARSE_STATUS as SWEEPABLE } from "../../src/processors/doc-ingest-selectors-logic";

const SMALL = 4 * 1024 * 1024; // the corpus average is 4.26 MB
const HUGE = 222 * 1024 * 1024; // the corpus MAXIMUM, 222.3 MB

const base = {
  gcsPath: "stocks/TCS/annual_report/2025.pdf",
  mimeType: "application/pdf",
  fileBytes: SMALL,
};

describe("MONEY-1314 — documents nothing can read", () => {
  it("an empty gcsPath is UNREADABLE, not FAILED", () => {
    // ~7,234 BSE rows carry gcsPath "" because BSE stopped serving the
    // attachment. UNREADABLE rather than FAILED because a forced run
    // re-selects FAILED, and these would be re-attempted on every pass
    // forever with a guaranteed identical outcome.
    for (const p of ["", "   ", null, undefined]) {
      const d = decideIngestLane({ ...base, gcsPath: p });
      assert.equal(d.lane, "skip");
      assert.equal(d.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
    }
  });

  it("scanned AND oversized has NO lane, and says so", () => {
    // THE asymmetry. Markdown needs a text layer; vision needs <= 50 MB.
    // A document failing both is a NAMED terminal outcome, countable in the
    // outcome report, rather than a mystery.
    const d = decideIngestLane({
      ...base,
      fileBytes: HUGE,
      convertStatus: "SCANNED_ONLY",
    });
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
    assert.match(d.reason, /scanned AND oversized/);
  });

  it("[control] oversized but CONVERTED still reads — markdown has no ceiling", () => {
    // The whole reason the markdown lane exists. Without this assertion, a
    // blanket size gate would satisfy the test above while making every large
    // annual report unreachable.
    const d = decideIngestLane({
      ...base,
      fileBytes: HUGE,
      convertStatus: "CONVERTED",
      markdownGcsPath: "stocks/TCS/annual_report/2025.pdf.md",
      textPageCount: 300,
    });
    assert.equal(d.lane, "markdown");
  });

  it("[control] scanned but SMALL goes to vision", () => {
    const d = decideIngestLane({ ...base, convertStatus: "SCANNED_ONLY" });
    assert.equal(d.lane, "vision");
  });

  it("a non-PDF mimeType is UNREADABLE", () => {
    const d = decideIngestLane({ ...base, mimeType: "application/zip" });
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
  });

  it("a parameterised PDF content-type is still a PDF", () => {
    // MONEY-1255: mimeType is written from the raw response header, and
    // "application/pdf;charset=UTF-8" made 1,211 rows permanently unreachable
    // through an exact match. Substring, not equality.
    const d = decideIngestLane({
      ...base,
      mimeType: "application/pdf;charset=UTF-8",
      convertStatus: "CONVERTED",
      markdownGcsPath: "x.md",
      textPageCount: 5,
    });
    assert.equal(d.lane, "markdown");
  });
});

describe("MONEY-1314 — the vision ceiling", () => {
  it("UNKNOWN size counts as TOO LARGE", () => {
    // The conservative direction. Guessing "small" sends a 222 MB upload at a
    // 50 MB endpoint and fails AFTER paying for the upload; guessing "large"
    // routes to markdown, which is the lane we wanted anyway.
    for (const v of [null, undefined, NaN, Infinity]) {
      assert.equal(exceedsVisionCeiling(v), true, `${v} should be refused`);
    }
  });

  it("[control] a real small size is accepted", () => {
    assert.equal(exceedsVisionCeiling(SMALL), false);
    assert.equal(exceedsVisionCeiling(MAX_PDF_BYTES), false);
    assert.equal(exceedsVisionCeiling(MAX_PDF_BYTES + 1), true);
  });

  it("the ceiling is Gemini's real limit, not a local invention", () => {
    // Imported, never restated — a second copy of this number is a drift
    // hazard the repo has paid for before.
    assert.equal(MAX_PDF_BYTES, 50 * 1024 * 1024);
  });
});

describe("MONEY-1314 — the existing corpus routes to CONVERT", () => {
  it("an ABSENT convertStatus is convertible — that is all 79,884 rows", () => {
    // `prisma db push` creates indexes, never fields. Every pre-existing row
    // has no convertStatus attribute at all, and this is the branch that has
    // to catch them.
    const d = decideIngestLane({ ...base });
    assert.equal(d.lane, "convert");
    assert.match(d.reason, /absent/);
  });

  it("PENDING and FAILED also convert", () => {
    for (const cs of ["PENDING", "FAILED"]) {
      assert.equal(
        decideIngestLane({ ...base, convertStatus: cs }).lane,
        "convert",
      );
    }
  });

  it("CONVERTED with no sidecar re-converts — the ARTIFACT wins over the status", () => {
    // Two writes that disagree. The sidecar is the artifact; the status is
    // only a claim about it. Trusting the claim sends an empty markdown to
    // the model, which correctly calls it UNPARSEABLE, which burns a lane
    // transition per document forever.
    const d = decideIngestLane({
      ...base,
      convertStatus: "CONVERTED",
      markdownGcsPath: null,
      textPageCount: 12,
    });
    assert.equal(d.lane, "convert");
    assert.match(d.reason, /status and the\s+artifact disagree/);
  });

  it("CONVERTED with a text layer and a sidecar goes to markdown", () => {
    const d = decideIngestLane({
      ...base,
      convertStatus: "CONVERTED",
      markdownGcsPath: "x.md",
      textPageCount: 12,
    });
    assert.equal(d.lane, "markdown");
  });

  it("CONVERTED but zero text pages falls to vision, not markdown", () => {
    // The garbage-text-layer population: classifyPdf said TextBased at
    // confidence 1.00 and the extraction yielded nothing. If a converter ever
    // stamps CONVERTED on one of those, this is the backstop.
    const d = decideIngestLane({
      ...base,
      convertStatus: "CONVERTED",
      markdownGcsPath: "x.md",
      textPageCount: 0,
    });
    assert.equal(d.lane, "vision");
  });

  it("hasUsableTextLayer requires a POSITIVE count", () => {
    assert.equal(hasUsableTextLayer({ textPageCount: 3 }), true);
    for (const v of [0, null, undefined]) {
      assert.equal(hasUsableTextLayer({ textPageCount: v }), false);
    }
  });
});

describe("MONEY-1314 — the vision retry after a gate failure", () => {
  it("a gate failure retries with vision when the document fits", () => {
    // The one case where spending vision tokens on a document we can already
    // read is worth it: a gate failure often means a table the converter
    // flattened wrongly, which vision sees correctly.
    const d = decideIngestLane(
      {
        ...base,
        convertStatus: "CONVERTED",
        markdownGcsPath: "x.md",
        textPageCount: 9,
      },
      { retryAfterGateFailure: true },
    );
    assert.equal(d.lane, "vision");
  });

  it("a gate failure on an OVERSIZED document is terminal FAILED_VALIDATION", () => {
    // There is no second lane. FAILED_VALIDATION rather than UNREADABLE
    // because the model DID answer — our arithmetic rejected it — and that is
    // a different finding for whoever reads the outcome.
    const d = decideIngestLane(
      {
        ...base,
        fileBytes: HUGE,
        convertStatus: "CONVERTED",
        markdownGcsPath: "x.md",
        textPageCount: 300,
      },
      { retryAfterGateFailure: true },
    );
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.FAILED_VALIDATION);
    assert.match(d.reason, /no second lane/);
  });

  it("the retry flag does NOT bypass the no-object check", () => {
    // Ordering matters: a missing object must be caught before the retry
    // branch, or a gate failure on a row with gcsPath "" would send an empty
    // download to the vision lane.
    const d = decideIngestLane(
      { ...base, gcsPath: "" },
      { retryAfterGateFailure: true },
    );
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
  });
});

describe("MONEY-1314 — outcome classification", () => {
  const c = classifyIngestOutcome;

  it("transient failures are retryable; deterministic ones are not", () => {
    for (const f of ["CALL_FAILED", "UNCONFIGURED"]) {
      const r = c({
        failure: f,
        gatePassed: false,
        periodsReturned: 2,
        wasRetry: false,
      });
      assert.equal(r.parseStatus, INGEST_PARSE_STATUS.FAILED);
      assert.equal(r.retryable, true);
    }
    const big = c({
      failure: "TOO_LARGE",
      gatePassed: false,
      periodsReturned: 2,
      wasRetry: false,
    });
    assert.equal(big.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
    assert.equal(big.retryable, false);
  });

  it("a gate failure earns ONE vision retry, and only one", () => {
    // Marking a deterministic failure retryable puts the same document into
    // every subsequent pass forever — how a queue stops draining without
    // anything looking wrong.
    const first = c({
      failure: null,
      gatePassed: false,
      periodsReturned: 2,
      wasRetry: false,
    });
    assert.equal(first.retryWithVision, true);
    assert.equal(first.retryable, true);

    const second = c({
      failure: null,
      gatePassed: false,
      periodsReturned: 2,
      wasRetry: true,
    });
    assert.equal(second.parseStatus, INGEST_PARSE_STATUS.FAILED_VALIDATION);
    assert.equal(second.retryWithVision, false);
    assert.equal(
      second.retryable,
      false,
      "a second gate failure must be terminal",
    );
  });

  it("an unreadable response also earns one retry, then stops", () => {
    assert.equal(
      c({
        failure: "UNPARSEABLE",
        gatePassed: false,
        periodsReturned: 2,
        wasRetry: false,
      }).retryWithVision,
      true,
    );
    const done = c({
      failure: "UNPARSEABLE",
      gatePassed: false,
      periodsReturned: 2,
      wasRetry: true,
    });
    assert.equal(done.parseStatus, INGEST_PARSE_STATUS.FAILED_VALIDATION);
    assert.equal(done.retryable, false);
  });

  it("success is EXTRACTED and never retried", () => {
    const r = c({
      failure: null,
      gatePassed: true,
      periodsReturned: 2,
      wasRetry: false,
    });
    assert.equal(r.parseStatus, INGEST_PARSE_STATUS.EXTRACTED);
    assert.equal(r.retryable, false);
    assert.equal(r.retryWithVision, false);
  });

  it("[control] no outcome is BOTH terminal and retryable", () => {
    // A self-contradictory verdict is how a row ends up simultaneously
    // never-revisited and re-selected every pass.
    for (const failure of [
      null,
      "CALL_FAILED",
      "UNCONFIGURED",
      "TOO_LARGE",
      "UNPARSEABLE",
    ]) {
      for (const gatePassed of [true, false]) {
        for (const wasRetry of [true, false]) {
          for (const periodsReturned of [0, 2]) {
            const r = c({ failure, gatePassed, periodsReturned, wasRetry });
            if (r.retryWithVision) {
              assert.equal(
                r.retryable,
                true,
                `${failure}/${gatePassed}/${periodsReturned}/${wasRetry}`,
              );
            }
            if (r.parseStatus === INGEST_PARSE_STATUS.EXTRACTED) {
              assert.equal(r.retryable, false);
            }
          }
        }
      }
    }
  });
});

describe("MONEY-1314 — splitting a stored sidecar back into pages", () => {
  it("splits on the markers the converter wrote, 1-indexed", () => {
    const md = "<!-- page 1 -->\nA\n\n<!-- page 5 -->\nB";
    assert.deepEqual(splitPageMarkedMarkdown(md), [
      { pageNumber: 1, markdown: "A" },
      { pageNumber: 5, markdown: "B" },
    ]);
  });

  it("an UNMARKED sidecar becomes ONE page, not zero", () => {
    // The failure this prevents: a sidecar written before the markers existed
    // splits into zero pages, the selector returns an empty selection, and the
    // model is sent empty markdown — which it correctly calls UNPARSEABLE.
    // That reads as a model problem and is a storage-format problem.
    const r = splitPageMarkedMarkdown("| Revenue | 1,000 |\n| Profit | 100 |");
    assert.equal(r.length, 1);
    assert.equal(r[0]?.pageNumber, 1);
    assert.match(r[0]?.markdown ?? "", /Revenue/);
  });

  it("a marker with an EMPTY body is dropped", () => {
    // An empty page would count toward the selector's density denominator and
    // dilute every real page on the document.
    assert.deepEqual(
      splitPageMarkedMarkdown("<!-- page 1 -->\n\n<!-- page 2 -->\nB"),
      [{ pageNumber: 2, markdown: "B" }],
    );
  });

  it("genuinely empty input is zero pages", () => {
    for (const v of ["", "   ", "\n\n"]) {
      assert.deepEqual(splitPageMarkedMarkdown(v), []);
    }
  });

  it("[control] markers-with-no-content do not silently become one big page", () => {
    // If EVERY marker has an empty body the fallback fires and returns the raw
    // text as page 1 — which is right (there is text, we just cannot place
    // it) and must not be confused with the zero-page case above.
    const r = splitPageMarkedMarkdown("preamble\n<!-- page 1 -->\n   ");
    assert.equal(r.length, 1);
    assert.match(r[0]?.markdown ?? "", /preamble/);
  });
});

describe("MONEY-1314 — the sidecar is RE-JUDGED on every read", () => {
  // A source scan, because the property lives in an I/O path and the failure
  // it prevents is silent. The converter runs the normaliser, learns whether
  // the tables are trustworthy, and then throws the verdict away: the sidecar
  // stores repaired markdown and NOTHING about whether the repair sufficed.
  //
  // Any later pass — the sweep, a forced re-ingest, a second delivery — would
  // read it blind. And that is the worst place for this defect: the damaged
  // cells are neighbours like `196.82`, silently truncated AND individually
  // valid, so an untrusted table can pass the arithmetic gate and be written
  // as fact.
  const src = readFileSync(
    new URL("../../src/processors/stock-document-ingest.ts", import.meta.url),
    "utf8",
  );
  const markdownBranch = (() => {
    const i = src.indexOf('if (lane === "markdown") {');
    assert.ok(i > 0, "the markdown branch was renamed — this scan is blind");
    // The branch ends where the VISION path begins. Anchored on the comment
    // that opens it rather than on a line of code, which moves.
    const end = src.indexOf("// REFUSE BEFORE DOWNLOADING", i);
    assert.ok(end > i, "the vision branch marker moved — this slice is blind");
    return src.slice(i, end);
  })();

  it("the markdown branch re-runs the normaliser on what it read", () => {
    assert.ok(
      markdownBranch.includes("normaliseDocumentMarkdown("),
      "the sidecar is read without re-judging it — the convert-time verdict is " +
        "not stored anywhere, so this is the only place it can be recovered",
    );
  });

  it("an untrustworthy sidecar routes to VISION rather than being read", () => {
    assert.ok(
      /failOverToVision/.test(markdownBranch) &&
        /runLane\(\s*"vision"/.test(markdownBranch),
      "re-judging without acting on the verdict is worse than not re-judging: " +
        "it computes the warning and discards it",
    );
  });

  it("the SELECTOR is fed the re-judged text, not the raw sidecar", () => {
    // Feeding `raw` here would drop the rupee repair on any sidecar written by
    // an older revision, and silently re-introduce the code-span corruption
    // that swallows table pipes.
    assert.ok(
      markdownBranch.includes("splitPageMarkedMarkdown(rejudged.markdown)"),
      "the page splitter is reading the raw sidecar rather than the re-judged text",
    );
  });

  it("[control] the scan can tell the two branches apart", () => {
    // Proves the slice is the markdown branch and not the whole file — a
    // whole-file scan would pass on the vision lane's own download call.
    assert.ok(!markdownBranch.includes("parsePdfFinancials("));
    assert.ok(src.includes("parsePdfFinancials("));
  });
});

describe("MONEY-1314 — a covering letter must not buy a vision call", () => {
  const c = classifyIngestOutcome;

  it("ZERO periods returned is terminal — no vision retry", () => {
    // The lane this replaces recorded the fact my design missed: a "quarterly
    // result" attachment that is really a covering letter returns no periods,
    // and that is "common and legitimate". Retrying each one costs a whole-PDF
    // vision call (~20,500 input tokens) to re-confirm there is nothing to
    // read — once per such document across 48,322.
    const r = c({
      failure: null,
      gatePassed: false,
      periodsReturned: 0,
      wasRetry: false,
    });
    assert.equal(r.parseStatus, INGEST_PARSE_STATUS.FAILED_VALIDATION);
    assert.equal(r.retryWithVision, false);
    assert.equal(r.retryable, false);
  });

  it("[control] periods returned but ALL invalid DOES earn the retry", () => {
    // The case the retry exists for: the model read statements and our
    // arithmetic rejected them, which usually means a table the converter
    // flattened wrongly — exactly what vision sees correctly. Without this,
    // "never retry" would satisfy the assertion above and disable the lane's
    // whole recovery path.
    const r = c({
      failure: null,
      gatePassed: false,
      periodsReturned: 3,
      wasRetry: false,
    });
    assert.equal(r.retryWithVision, true);
    assert.equal(r.retryable, true);
  });

  it("zero periods on the VISION lane is terminal too", () => {
    const r = c({
      failure: null,
      gatePassed: false,
      periodsReturned: 0,
      wasRetry: true,
    });
    assert.equal(r.retryWithVision, false);
    assert.equal(r.retryable, false);
  });

  it("a SUCCESSFUL read is unaffected by the period count", () => {
    for (const periodsReturned of [1, 5]) {
      const r = c({
        failure: null,
        gatePassed: true,
        periodsReturned,
        wasRetry: false,
      });
      assert.equal(r.parseStatus, INGEST_PARSE_STATUS.EXTRACTED);
    }
  });
});

describe("MONEY-1314 — the processor must SUPPLY what the routing needs", () => {
  // Both fatal defects in this lane were of one shape: the unit test's fixture
  // supplied a field the only production caller did not. `fileBytes: SMALL` is
  // pinned in the fixture at the top of this file, while the Prisma `select`
  // omitted `fileSize` entirely — so `exceedsVisionCeiling` was permanently
  // true in production and permanently false under test.
  //
  // These read the PROCESSOR source, because that is where the mismatch lives.
  const src = readFileSync(
    new URL("../../src/processors/stock-document-ingest.ts", import.meta.url),
    "utf8",
  );
  const select = (() => {
    const i = src.indexOf("select: {");
    assert.ok(i > 0, "the findUnique select was renamed — this scan is blind");
    return src.slice(i, src.indexOf("\n      }", i));
  })();

  it("`fileSize` is SELECTED — without it the vision lane is unreachable", () => {
    // The column is `fileSize`; IngestDocState calls it `fileBytes`. Omitting
    // it typechecks silently (the field is optional) and makes every scanned
    // document terminally UNREADABLE with "scanned AND oversized" — including
    // a 180 KB BSE quarterly.
    assert.ok(
      /\bfileSize:\s*true\b/.test(select),
      "the findUnique select omits fileSize, so doc.fileBytes is always " +
        "undefined and exceedsVisionCeiling — unknown size = too large, by " +
        "design — is permanently TRUE",
    );
  });

  it("every field IngestDocState routes on is selected", () => {
    // Named individually so ADDING a routing input without selecting it fails
    // here rather than in production.
    for (const [col, why] of [
      ["gcsPath", "the empty-path skip"],
      ["mimeType", "the PDF test"],
      ["fileSize", "the vision ceiling"],
      ["convertStatus", "the convert branch"],
      ["markdownGcsPath", "the artifact-wins-over-status check"],
      ["textPageCount", "hasUsableTextLayer"],
    ] as const) {
      assert.ok(
        new RegExp(`\\b${col}:\\s*true\\b`).test(select),
        `${col} is not selected, but the routing reads it for ${why}`,
      );
    }
  });

  it("`fileSize` is mapped onto `fileBytes`, not passed through", () => {
    // The two names differ, and a spread of the Prisma row would leave
    // `fileBytes` undefined while looking correct.
    assert.ok(
      /fileBytes:\s*doc\.fileSize/.test(src),
      "fileSize must be mapped to fileBytes explicitly",
    );
  });

  it("runLane is handed the UPDATED state, never the pre-conversion row", () => {
    // The fatal one: the convert branch wrote the sidecar path into a local,
    // spread it into the throwaway object given to decideIngestLane, and then
    // passed the ORIGINAL `doc` to runLane — whose markdown branch reads
    // `markdownGcsPath`, still null from the database. Every document
    // converted in the same message threw on downloadFromGCS(null).
    assert.ok(
      /runLane\(\s*decision\.lane,\s*state,/.test(src),
      "runLane is being passed something other than the updated `state`",
    );
    assert.ok(
      !/runLane\([^)]*,\s*doc,/.test(src),
      "a runLane call still passes the raw Prisma row",
    );
  });

  it("[control] the scan can see a field that is genuinely absent", () => {
    // Proves the regex discriminates rather than matching anything.
    assert.ok(!/\bnoSuchColumn:\s*true\b/.test(select));
  });
});

describe("MONEY-1314 — a status must not claim a model answered", () => {
  const HUGE_DOC = {
    ...base,
    fileBytes: HUGE,
    convertStatus: "CONVERTED",
    markdownGcsPath: "x.md",
    textPageCount: 40,
  };

  it("untrusted markdown + oversized is UNREADABLE, not FAILED_VALIDATION", () => {
    // FAILED_VALIDATION means "the model answered and our arithmetic rejected
    // it". Here the NORMALISER rejected the markdown and no model was ever
    // asked. Recording it as a validation failure attributes a verdict to a
    // model that never ran — and puts the row in the sweep's re-read set for
    // an answer that was never produced.
    const d = decideIngestLane(HUGE_DOC, { untrustedMarkdown: true });
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
    assert.match(d.reason, /no model has been asked/);
  });

  it("[control] a REAL gate failure at the same size stays FAILED_VALIDATION", () => {
    // The discriminator. Without this, "always UNREADABLE" satisfies the
    // assertion above and erases the distinction entirely — a genuinely
    // rejected reading would stop being visible as one.
    const d = decideIngestLane(HUGE_DOC, { retryAfterGateFailure: true });
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.FAILED_VALIDATION);
    assert.match(d.reason, /failed the arithmetic gate/);
  });

  it("both routes to VISION when the document fits", () => {
    // The ROUTING is identical — only the terminal status differs, and only
    // when there is no lane left.
    for (const opts of [
      { untrustedMarkdown: true },
      { retryAfterGateFailure: true },
    ]) {
      const d = decideIngestLane({ ...HUGE_DOC, fileBytes: SMALL }, opts);
      assert.equal(d.lane, "vision", JSON.stringify(opts));
    }
  });

  it("the PROCESSOR passes untrustedMarkdown, not retryAfterGateFailure", () => {
    // The wiring, checked in source — the whole distinction is worthless if
    // the convert path still reports a normaliser rejection as a gate failure.
    // A mutation flipping this flag survived every behavioural assertion
    // above, because they all call `decideIngestLane` directly.
    const src = readFileSync(
      new URL("../../src/processors/stock-document-ingest.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /untrustedMarkdown:\s*converted\.failOverToVision/,
      "the convert path must report the normaliser's rejection as " +
        "`untrustedMarkdown` — nothing has read the document at that point",
    );
    assert.ok(
      !/retryAfterGateFailure:\s*converted\./.test(src),
      "the convert path still reports a normaliser rejection as a gate failure",
    );
  });

  it("UNREADABLE is terminal; FAILED_VALIDATION is swept", () => {
    // Why the distinction is load-bearing rather than cosmetic: the sweep
    // re-opens FAILED_VALIDATION and would re-read the same untrustworthy
    // sidecar, while UNREADABLE stops.
    assert.ok(!SWEEPABLE.includes(INGEST_PARSE_STATUS.UNREADABLE));
    assert.ok(SWEEPABLE.includes(INGEST_PARSE_STATUS.FAILED_VALIDATION));
  });
});

/**
 * TRUNCATION IS OUR CEILING, NOT THE MODEL'S ANSWER — MONEY-1334.
 *
 * A truncated response and a malformed one are the same unreadable text, and
 * before this they were the same classification: UNPARSEABLE, which on a first
 * attempt returns `retryWithVision: true`. Measured in the MONEY-1332 pilot,
 * 15 of 22 responses finished MAX_TOKENS — every one would have bought a
 * whole-PDF vision retry it could not benefit from, because vision runs under
 * the SAME output ceiling.
 */
describe("MONEY-1334 — a truncated answer must never buy a vision retry", () => {
  const base = { gatePassed: false, periodsReturned: 0 };

  it("routes TRUNCATED to FAILED, retryable, but NOT via vision", () => {
    const out = classifyIngestOutcome({
      ...base,
      failure: "TRUNCATED",
      wasRetry: false,
    });
    assert.equal(
      out.retryWithVision,
      false,
      "vision runs under the same ceiling — the retry spends a GCS download, " +
        "a Files API upload and a second paid generation to hit the same wall",
    );
    assert.equal(
      out.retryable,
      true,
      "raising the ceiling and re-sweeping is the fix",
    );
    assert.equal(
      out.parseStatus,
      "FAILED",
      "FAILED is what buildSweepQuery re-opens",
    );
  });

  it("does not become terminal just because it happened on the vision lane", () => {
    // A ceiling problem is identical on both transports, so `wasRetry` must not
    // change the verdict — unlike UNPARSEABLE, where the second attempt really
    // has exhausted the options.
    const first = classifyIngestOutcome({
      ...base,
      failure: "TRUNCATED",
      wasRetry: false,
    });
    const retry = classifyIngestOutcome({
      ...base,
      failure: "TRUNCATED",
      wasRetry: true,
    });
    assert.deepEqual(retry, first);
  });

  it("still sends a genuinely UNPARSEABLE first attempt to vision", () => {
    // The control. If this flips, the new arm has swallowed the old one and a
    // real model-side failure silently loses its one useful retry.
    const out = classifyIngestOutcome({
      ...base,
      failure: "UNPARSEABLE",
      wasRetry: false,
    });
    assert.equal(out.retryWithVision, true);
  });
});

describe("MONEY-1348 — a currency we cannot store is DECLINED, not retried", () => {
  const base = {
    failure: null,
    gatePassed: false,
    periodsReturned: 2,
    wasRetry: false,
  };

  it("lands UNSUPPORTED, terminal, with no vision retry", () => {
    // Vision would read the same dollars, at ~3x the input tokens, once per
    // such document across the corpus.
    const out = classifyIngestOutcome({
      ...base,
      rejectionReasons: ["NON_INR_CURRENCY", "NON_INR_CURRENCY"],
    });
    assert.equal(out.parseStatus, INGEST_PARSE_STATUS.UNSUPPORTED);
    assert.equal(out.retryable, false);
    assert.equal(out.retryWithVision, false);
  });

  it("is TERMINAL, so no forced pass re-selects it", () => {
    assert.ok(
      TERMINAL_PARSE_STATUSES.includes(INGEST_PARSE_STATUS.UNSUPPORTED),
      "a currency we cannot store does not become storable on a retry",
    );
  });

  it("still buys a vision retry when the currency is only ONE of the reasons", () => {
    // A document rejected for a currency AND a broken balance sheet is still a
    // parse problem worth re-reading.
    const out = classifyIngestOutcome({
      ...base,
      rejectionReasons: ["NON_INR_CURRENCY", "BALANCE_SHEET_IMBALANCE"],
    });
    assert.notEqual(out.parseStatus, INGEST_PARSE_STATUS.UNSUPPORTED);
    assert.equal(out.retryWithVision, true);
  });

  it("keeps the OLD behaviour when a caller supplies no reasons at all", () => {
    // Absent is not empty. A caller that forgets to pass them must degrade to
    // what it did before, never to a terminal status.
    const out = classifyIngestOutcome(base);
    assert.notEqual(out.parseStatus, INGEST_PARSE_STATUS.UNSUPPORTED);
    assert.deepEqual(
      out,
      classifyIngestOutcome({ ...base, rejectionReasons: [] }),
      "an empty reason list and an absent one must decide identically",
    );
  });

  it("does not fire when the gate PASSED", () => {
    const out = classifyIngestOutcome({
      ...base,
      gatePassed: true,
      rejectionReasons: ["NON_INR_CURRENCY"],
    });
    assert.equal(out.parseStatus, INGEST_PARSE_STATUS.EXTRACTED);
  });
});

/**
 * MONEY-1511 — whole-PDF vision is OFF, and the documents it would have read
 * must be REFUSED BY NAME rather than dropped.
 *
 * The lane uploads the whole PDF to the Gemini Files API (upload -> activate ->
 * generate -> delete, ~4 billed calls each) and it is the RETRY, so it fires on
 * exactly the documents the cheap lane could not read. Founder decision: the
 * cost exceeds the value of the data, and losing some coverage is accepted.
 *
 * Accepting the loss is not the same as hiding it. Every case below asserts a
 * NAMED reason and the correct terminal status.
 */
describe("MONEY-1511 — vision disabled", () => {
  const scanned = { ...base, convertStatus: "SCANNED_ONLY" as const };

  it("[control] both paths still reach vision when ARMED", () => {
    assert.equal(decideIngestLane(scanned).lane, "vision");
    assert.equal(
      decideIngestLane(base, { retryAfterGateFailure: true }).lane,
      "vision",
    );
  });

  it("a SCANNED document becomes UNREADABLE, naming the flag", () => {
    const d = decideIngestLane(scanned, { visionDisabled: true });
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
    assert.match(d.reason, /DOC_VISION_APPLY/);
  });

  it("a gate FAILURE becomes FAILED_VALIDATION — a model did answer", () => {
    // The status must still distinguish "a model answered and our arithmetic
    // rejected it" from "nothing could read it". Collapsing the two would put
    // the row in the wrong re-read set.
    const d = decideIngestLane(base, {
      retryAfterGateFailure: true,
      visionDisabled: true,
    });
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.FAILED_VALIDATION);
    assert.match(d.reason, /DOC_VISION_APPLY/);
  });

  it("UNTRUSTED markdown becomes UNREADABLE — no model was asked", () => {
    const d = decideIngestLane(base, {
      retryAfterGateFailure: true,
      untrustedMarkdown: true,
      visionDisabled: true,
    });
    assert.equal(d.lane, "skip");
    assert.equal(d.parseStatus, INGEST_PARSE_STATUS.UNREADABLE);
    assert.match(d.reason, /DOC_VISION_APPLY/);
  });

  it("disabling vision does NOT disturb the cheap lanes", () => {
    // The whole point: markdown and convert must be untouched, or this becomes
    // a coverage cut far larger than the one that was agreed.
    assert.equal(
      decideIngestLane(
        { ...base, convertStatus: undefined },
        { visionDisabled: true },
      ).lane,
      "convert",
    );
  });

  it("the flag is the LITERAL string, and absent is off", () => {
    // Boolean("false") is true, which would arm the one configuration meant to
    // keep it off.
    assert.equal(isVisionArmed({ [DOC_VISION_APPLY_ENV]: "true" }), true);
    for (const v of ["false", "", "1", "TRUE", "yes", undefined]) {
      assert.equal(
        isVisionArmed(v === undefined ? {} : { [DOC_VISION_APPLY_ENV]: v }),
        false,
        `"${v}" must not arm the lane`,
      );
    }
  });
});
