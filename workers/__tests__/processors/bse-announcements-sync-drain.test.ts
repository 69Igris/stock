/**
 * SEAM TESTS — the four mechanisms that left 2,339 BSE filings without their
 * PDFs (MONEY-1285).
 *
 * ## Why these drive the processor rather than the pure helpers
 *
 * The next-door files cover the two halves this one cannot: `-logic.test.ts`
 * asserts the pure judgements, `-reporting.test.ts` asserts source structure.
 * Neither can express the four properties this ticket is about, because all
 * four are properties of the ORCHESTRATION:
 *
 *   - a byte-less row is RETRIED (the decision function returning
 *     `write-retry-bytes` proves nothing if the caller `continue`s above it —
 *     which is exactly what it did),
 *   - no category is starved by the download cap,
 *   - the run stops inside its budget and publishes ONE follow-up,
 *   - a scrip code resolves an instrument.
 *
 * MONEY-1092/1093 is this repo's standing example of a fix that was correct in
 * the unit and inert at the call site, so every case below calls the REAL
 * exported `processBseAnnouncementsSync` through its injected I/O seam. The
 * seam's defaults are the real Prisma / GCS / fetch / Pub/Sub clients, so the
 * production path and these tests run the same function.
 *
 * ## The measurement these are written against
 *
 * Prod, 2026-08-30, `stock_documents` where `sourceType: "BSE"`:
 *
 *     docType             rows     with bytes   gcsPath: ""
 *     corporate_filing    4,268     1,929        2,339
 *     quarterly_result   30,956    27,170        3,786
 *
 * The 2,339 are all from the last FOUR DAYS and BSE is serving those
 * attachments right now. By category, `corporate_filing` splits cleanly:
 * AGM/EGM and Board Meeting ~100% complete, and Corp. Action, Insider
 * Trading/SAST, New Listing, Result and Others 100% byte-less. Three post-fix
 * runs each archived EXACTLY "500 PDFs" — `MAX_PDF_DOWNLOADS_PER_RUN` — while
 * storing 775-1,852 rows, in 19-21 minutes against a 600s ack deadline.
 *
 * ## Why each assertion is falsifiable
 *
 * Every case carries its CONTROL — the input that must NOT produce the
 * behaviour — because "a download was attempted" is trivially true of a
 * processor that downloads unconditionally, and "each category got some" is
 * trivially true of a run whose cap never binds. The mutation that must turn
 * each case red is named on the case.
 *
 * There is no clock, no timer and no network here: `now` and `sleep` are
 * injected, so nothing can orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  processBseAnnouncementsSync,
  type BseAnnouncementsSyncDeps,
  type BseAttachmentResponse,
  type BseDocumentUpsertArgs,
  type ExistingBseDocument,
  type NamedInstrument,
  type ResolvedInstrument,
} from "../../src/processors/bse-announcements-sync";
import {
  BSE_MAX_CHAIN_DEPTH,
  BSE_RUN_TIME_BUDGET_MS,
} from "../../src/processors/bse-announcements-sync-logic";
import type {
  BseAnnouncement,
  BseAnnouncementsFetch,
} from "@usemoney/research/data-sources/bse-client";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** The cap the processor applies per run. Restated here ONLY as the number the
 *  round-robin case has to exceed; the assertions read the observed downloads,
 *  never this constant, so a change to it cannot make the case vacuous. */
const CAP = 500;

/** A PDF body comfortably over the processor's 1,000-byte error-page floor. */
const PDF_BYTES = Buffer.alloc(2048, 0x25);

function ann(over: Partial<BseAnnouncement> = {}): BseAnnouncement {
  return {
    scripCode: "500325",
    symbol: "RELIANCE",
    company: "Reliance Industries Ltd",
    title: "Board Meeting Intimation",
    description: "",
    category: "Board Meeting",
    subcategory: "",
    pdfUrl: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/a-1.pdf",
    newsId: "n-1",
    xmlName: "ANN_500325_A",
    quarterId: "",
    publishedAt: new Date("2026-08-30T04:00:00Z"),
    ...over,
  };
}

function fetchResult(announcements: BseAnnouncement[]): BseAnnouncementsFetch {
  const counts = new Map<string, number>();
  for (const a of announcements) {
    counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  }
  return {
    announcements,
    byCategory: [...counts].map(([category, count]) => ({
      category,
      count,
      pages: 1,
      stop: "exhausted" as const,
    })),
    transportFailures: 0,
    window: { from: "20260828", to: "20260830" },
    futureDateStepBacks: 0,
  };
}

interface Harness {
  deps: BseAnnouncementsSyncDeps;
  /** Attachment URLs the run actually fetched, in order. */
  downloads: string[];
  /** GCS objects written. */
  uploads: string[];
  upserts: BseDocumentUpsertArgs[];
  /** Follow-up messages published. Length is the once-per-run assertion. */
  published: Record<string, unknown>[];
  /** The last clock value the run observed — its total wall time. */
  clock: { ms: number };
}

/**
 * Build the seam.
 *
 * `msPerDownload` is how the budget is exercised: the injected clock advances
 * only when an attachment is fetched, so a case chooses exactly how many
 * downloads fit inside `BSE_RUN_TIME_BUDGET_MS` and the run is otherwise
 * instantaneous and deterministic.
 */
function harness(opts: {
  announcements: BseAnnouncement[];
  /** Rows already in `stock_documents`, keyed `symbol|exchange|docType|period`. */
  existing?: Map<string, ExistingBseDocument>;
  instrumentsByScripCode?: Map<string, ResolvedInstrument>;
  instrumentsBySymbol?: Map<string, ResolvedInstrument>;
  instrumentsByNamePrefix?: Map<string, NamedInstrument[]>;
  msPerDownload?: number;
  /** Status the attachment host answers with. 200 unless a case says otherwise. */
  attachmentStatus?: number;
}): Harness {
  const downloads: string[] = [];
  const uploads: string[] = [];
  const upserts: BseDocumentUpsertArgs[] = [];
  const published: Record<string, unknown>[] = [];
  const clock = { ms: 1_000_000 };
  const existing = opts.existing ?? new Map<string, ExistingBseDocument>();
  const byScrip = opts.instrumentsByScripCode ?? new Map();
  const bySymbol =
    opts.instrumentsBySymbol ??
    new Map<string, ResolvedInstrument>([
      ["RELIANCE", { id: "i-rel", symbol: "RELIANCE", exchange: "BSE" }],
    ]);
  const byName = opts.instrumentsByNamePrefix ?? new Map();
  const status = opts.attachmentStatus ?? 200;

  const deps: BseAnnouncementsSyncDeps = {
    fetchAnnouncements: async () => fetchResult(opts.announcements),
    findInstrumentByScripCode: async (code) => byScrip.get(code) ?? null,
    findInstrumentBySymbol: async (symbol) => bySymbol.get(symbol) ?? null,
    findInstrumentsByNamePrefix: async (prefix) => byName.get(prefix) ?? [],
    findExistingDocument: async (key) =>
      existing.get(
        [key.symbol, key.exchange, key.docType, key.period].join("|"),
      ) ?? null,
    upsertDocument: async (args) => {
      upserts.push(args);
    },
    downloadAttachment: async (url): Promise<BseAttachmentResponse> => {
      downloads.push(url);
      clock.ms += opts.msPerDownload ?? 0;
      return {
        ok: status >= 200 && status < 300,
        status,
        contentType: "application/pdf",
        body: PDF_BYTES,
      };
    },
    uploadAttachment: async (path) => {
      uploads.push(path);
    },
    publishFollowUp: async (message) => {
      published.push(message);
    },
    now: () => clock.ms,
    // No real waiting: the 1500ms production pace is a property of the SOURCE
    // (asserted in the reporting test), not something a unit test should spend.
    sleep: async () => {},
  };

  return { deps, downloads, uploads, upserts, published, clock };
}

/* -------------------------------------------------------------------------- */
/* 1. The retry arm — the change that unstrands the 2,339                      */
/* -------------------------------------------------------------------------- */

describe("MONEY-1285 — a byte-less corporate_filing is RETRIED, not skipped", () => {
  /**
   * MUTATION THAT MUST GO RED: restore the unconditional skip in
   * `processBseAnnouncementsSync`
   *
   *     if (existing && !isQuarterly) { skippedExisting++; continue; }
   *
   * With it back, `downloads` is empty and `upserts` is empty — the row keeps
   * `gcsPath: ""` forever, because a `corporate_filing`'s period is
   * `bse-{newsId}` and therefore matches an existing row on EVERY later run.
   */
  it("attempts the download and updates the row", async () => {
    const existing = new Map<string, ExistingBseDocument>([
      [
        "RELIANCE|BSE|corporate_filing|bse-n-1",
        {
          description: "prose\nbse-meta xml=X;attach=a-1.pdf;newsid=n-1;cat=Board Meeting;sub=",
          sourceUrl:
            "https://www.bseindia.com/xml-data/corpfiling/AttachLive/a-1.pdf",
          gcsPath: "",
          fileSize: 0,
        },
      ],
    ]);
    const h = harness({ announcements: [ann()], existing });

    await processBseAnnouncementsSync({}, h.deps);

    assert.equal(
      h.downloads.length,
      1,
      "the stranded row's attachment was never re-fetched",
    );
    assert.equal(h.upserts.length, 1, "the row was not re-written");
    const update = h.upserts[0]!.update;
    assert.ok(
      update.gcsPath.length > 0,
      "the retry wrote an empty gcsPath again",
    );
    assert.equal(update.fileSize, PDF_BYTES.length);
    assert.equal(update.processingStatus, "PENDING");
  });

  /**
   * THE CONTROL. Without this, the case above passes for a processor that
   * downloads unconditionally — which would re-fetch all 4,268 rows every
   * night and put the run right back over its ack deadline.
   */
  it("CONTROL: a row that ALREADY has its bytes is skipped", async () => {
    const existing = new Map<string, ExistingBseDocument>([
      [
        "RELIANCE|BSE|corporate_filing|bse-n-1",
        {
          description: "bse-meta xml=X;attach=a-1.pdf;newsid=n-1;cat=Board Meeting;sub=",
          sourceUrl:
            "https://www.bseindia.com/xml-data/corpfiling/AttachLive/a-1.pdf",
          gcsPath: "stocks/RELIANCE/corporate_filing/x.pdf",
          fileSize: 4096,
        },
      ],
    ]);
    const h = harness({ announcements: [ann()], existing });

    await processBseAnnouncementsSync({}, h.deps);

    assert.deepEqual(h.downloads, [], "an already-archived row was re-fetched");
    assert.deepEqual(h.upserts, [], "an already-archived row was re-written");
  });

  it("a quarterly row with no bytes is retried on the same terms", async () => {
    // The quarterly branch always had this arm. Asserted here so the unified
    // decision cannot be "fixed" for corporate_filing by breaking quarterly.
    const results = ann({
      category: "Result",
      title: "UNAUDITED RESULTS FOR THE QUARTER ENDED 30/06/2026",
      newsId: "n-q",
      pdfUrl: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/q-1.pdf",
    });
    const existing = new Map<string, ExistingBseDocument>([
      [
        "RELIANCE|BSE|quarterly_result|Jun 2026",
        {
          description: "bse-meta xml=X;attach=q-1.pdf;newsid=n-q;cat=Result;sub=",
          sourceUrl:
            "https://www.bseindia.com/xml-data/corpfiling/AttachLive/q-1.pdf",
          gcsPath: "",
          fileSize: 0,
        },
      ],
    ]);
    const h = harness({ announcements: [results], existing });

    await processBseAnnouncementsSync({}, h.deps);

    assert.equal(h.downloads.length, 1);
    assert.equal(h.upserts.length, 1);
    assert.ok(h.upserts[0]!.update.gcsPath.length > 0);
  });

  it("a bytes-RETRY does not invent a supersession in the breadcrumb", async () => {
    // Same attachment name, no bytes. The trail must stay empty: recording a
    // revision that never happened is worse than recording nothing.
    const existing = new Map<string, ExistingBseDocument>([
      [
        "RELIANCE|BSE|corporate_filing|bse-n-1",
        {
          description: "bse-meta xml=X;attach=a-1.pdf;newsid=n-1;cat=Board Meeting;sub=",
          sourceUrl:
            "https://www.bseindia.com/xml-data/corpfiling/AttachLive/a-1.pdf",
          gcsPath: "",
          fileSize: 0,
        },
      ],
    ]);
    const h = harness({ announcements: [ann()], existing });

    await processBseAnnouncementsSync({}, h.deps);

    assert.ok(
      !h.upserts[0]!.update.description.includes("superseded="),
      "a bytes retry was recorded as a revision",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Round-robin — no category may be deterministically last                  */
/* -------------------------------------------------------------------------- */

describe("MONEY-1285 — the download cap samples every category", () => {
  /**
   * MUTATION THAT MUST GO RED: drop the `interleaveByCategory` call and iterate
   * `fetched.announcements` (the client's category-MAJOR order) directly.
   *
   * With 3 x 300 rows against a 500-download cap, strict category order gives
   * category A 300, category B 200 and category C **ZERO** — which is the prod
   * measurement exactly: five categories 100% byte-less behind two that are
   * ~100% complete.
   */
  it("three categories x 300 rows against a cap of 500: every category is reached", async () => {
    const categories = ["AGM/EGM", "Corp. Action", "Others"];
    const announcements: BseAnnouncement[] = [];
    for (const category of categories) {
      for (let i = 0; i < 300; i++) {
        announcements.push(
          ann({
            category,
            newsId: `${category}-${i}`,
            pdfUrl: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${encodeURIComponent(category)}-${i}.pdf`,
          }),
        );
      }
    }
    assert.equal(announcements.length, 900, "fixture must exceed the cap");

    const h = harness({ announcements, msPerDownload: 0 });
    await processBseAnnouncementsSync({}, h.deps);

    // The cap bound (this is what makes the case meaningful at all).
    assert.equal(
      h.downloads.length,
      CAP,
      `expected the run to stop at the cap, got ${h.downloads.length}`,
    );

    const perCategory = new Map<string, number>();
    for (const url of h.downloads) {
      const name = decodeURIComponent(url.split("/").pop() ?? "");
      const category = categories.find((c) => name.startsWith(`${c}-`));
      assert.ok(category, `could not attribute ${name} to a category`);
      perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
    }

    for (const category of categories) {
      const got = perCategory.get(category) ?? 0;
      assert.ok(
        got > 0,
        `category "${category}" received ZERO downloads — ` +
          `${[...perCategory].map(([c, n]) => `${c}=${n}`).join(" ")}`,
      );
    }

    // Fairness, not merely non-zero: a round-robin over equal-sized groups
    // splits within one of even. A "shuffle the first few" fix would pass the
    // non-zero test and fail this one.
    const counts = [...perCategory.values()];
    assert.ok(
      Math.max(...counts) - Math.min(...counts) <= 1,
      `the split is not round-robin: ${counts.join("/")}`,
    );
  });

  it("preserves within-category order, so the chain can resume by index", async () => {
    // `resumeIndex` indexes into the interleaved permutation, so the ordering
    // has to be a pure deterministic function of the fetch. Two rows of one
    // category must still come back in their original relative order.
    const announcements = [
      ann({ category: "A", newsId: "a0", pdfUrl: "https://x/AttachLive/a0.pdf" }),
      ann({ category: "A", newsId: "a1", pdfUrl: "https://x/AttachLive/a1.pdf" }),
      ann({ category: "B", newsId: "b0", pdfUrl: "https://x/AttachLive/b0.pdf" }),
      ann({ category: "B", newsId: "b1", pdfUrl: "https://x/AttachLive/b1.pdf" }),
    ];
    const h = harness({ announcements });
    await processBseAnnouncementsSync({}, h.deps);

    const names = h.downloads.map((u) => u.split("/").pop());
    assert.deepEqual(names, ["a0.pdf", "b0.pdf", "a1.pdf", "b1.pdf"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The wall clock and the chain                                             */
/* -------------------------------------------------------------------------- */

describe("MONEY-1285 — the run stops inside its budget and chains the rest", () => {
  /**
   * MUTATION THAT MUST GO RED: delete the
   * `if (!isWithinBseRunBudget(startedAt, deps.now())) break;` guard.
   *
   * Without it all 20 announcements are handled, `remaining` is 0, the chain
   * decision reads `window-drained` and NOTHING is published — so both the
   * `published.length === 1` and the `upserts.length === 7` assertions fail,
   * and the observed wall clock lands at 1,200,000ms, twice the 600s ack
   * deadline the whole budget exists to stay inside.
   */
  it("publishes ONE follow-up carrying the remaining work", async () => {
    const msPerDownload = 60_000;
    const fits = Math.ceil(BSE_RUN_TIME_BUDGET_MS / msPerDownload); // 7
    const announcements = Array.from({ length: 20 }, (_, i) =>
      ann({
        category: "Board Meeting",
        newsId: `n-${i}`,
        pdfUrl: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/p-${i}.pdf`,
      }),
    );
    const h = harness({ announcements, msPerDownload });
    const startedAt = h.clock.ms;

    await processBseAnnouncementsSync({}, h.deps);

    assert.equal(
      h.downloads.length,
      fits,
      `expected the budget to stop the loop at ${fits}, got ${h.downloads.length}`,
    );
    assert.equal(h.upserts.length, fits, "rows were written past the budget");

    // Inside the ACK DEADLINE, which is the number the budget is derived from.
    // 600s is Pub/Sub's maximum and cannot be raised; overrunning it does not
    // make the run slow, it starts a SECOND concurrent copy on the same window.
    const elapsed = h.clock.ms - startedAt;
    assert.ok(
      elapsed < 600_000,
      `the run observed ${elapsed}ms, past the 600s ack deadline`,
    );

    assert.equal(
      h.published.length,
      1,
      `expected exactly ONE follow-up per run, got ${h.published.length}`,
    );
    const next = h.published[0]!;
    assert.equal(next.chainDepth, 1);
    assert.equal(
      next.resumeIndex,
      fits,
      "the follow-up does not resume where this link stopped",
    );
    // The EFFECTIVE window, not the requested one: resumeIndex indexes into the
    // ordering that window produced.
    assert.equal(next.fromDate, "2026-08-28");
    assert.equal(next.toDate, "2026-08-30");
  });

  /**
   * THE CONTROL, and the termination proof's other half. A run that consumed
   * the whole window must NOT chain — otherwise every night becomes
   * BSE_MAX_CHAIN_DEPTH full re-walks of a drained window.
   */
  it("CONTROL: a drained window publishes nothing", async () => {
    const h = harness({
      announcements: [ann({ newsId: "n-a" }), ann({ newsId: "n-b" })],
    });
    await processBseAnnouncementsSync({}, h.deps);

    assert.equal(h.upserts.length, 2);
    assert.deepEqual(h.published, [], "a drained window still chained");
  });

  it("CONTROL: the last permitted depth does not chain", async () => {
    const msPerDownload = 60_000;
    const announcements = Array.from({ length: 20 }, (_, i) =>
      ann({ newsId: `n-${i}`, pdfUrl: `https://x/AttachLive/p-${i}.pdf` }),
    );
    const h = harness({ announcements, msPerDownload });

    await processBseAnnouncementsSync(
      { chainDepth: BSE_MAX_CHAIN_DEPTH - 1 } as never,
      h.deps,
    );

    assert.ok(h.upserts.length > 0, "the link did no work at all");
    assert.deepEqual(
      h.published,
      [],
      `depth ${BSE_MAX_CHAIN_DEPTH - 1} published a follow-up — the chain is unbounded`,
    );
  });

  it("CONTROL: a 429 from the attachment host does not chain", async () => {
    // Limiter state is PER RUN, so a fresh link re-arms the breaker straight
    // back into the same wall — the rule `shouldChainShard` and
    // `stock-document-sync` already established.
    const announcements = Array.from({ length: 20 }, (_, i) =>
      ann({ newsId: `n-${i}`, pdfUrl: `https://x/AttachLive/p-${i}.pdf` }),
    );
    const h = harness({
      announcements,
      msPerDownload: 60_000,
      attachmentStatus: 429,
    });

    await processBseAnnouncementsSync({}, h.deps);

    assert.deepEqual(
      h.published,
      [],
      "a rate-limited run chained straight back into the block",
    );
  });

  it("resumes at the index the follow-up carries", async () => {
    // The resume is what makes the chain make PROGRESS rather than re-doing
    // the same head — which matters precisely because the retry arm now
    // re-attempts byte-less rows and would otherwise re-attempt the same ones
    // on every link forever.
    const announcements = Array.from({ length: 6 }, (_, i) =>
      ann({ newsId: `n-${i}`, pdfUrl: `https://x/AttachLive/p-${i}.pdf` }),
    );
    const h = harness({ announcements });

    await processBseAnnouncementsSync({ resumeIndex: 4 } as never, h.deps);

    assert.deepEqual(
      h.downloads.map((u) => u.split("/").pop()),
      ["p-4.pdf", "p-5.pdf"],
      "the run did not resume at the carried index",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The scrip-code rung                                                      */
/* -------------------------------------------------------------------------- */

describe("MONEY-1285 — an announcement resolves by BSE's own scrip code", () => {
  /**
   * MUTATION THAT MUST GO RED: delete the `findInstrumentByScripCode` rung from
   * `resolveInstrument`.
   *
   * Without it this announcement — whose symbol is unknown to us and whose
   * company name matches nothing — is counted `unresolved` and dropped, which
   * is the ~420 rows a night the three post-fix prod runs reported as `failed`.
   */
  it("resolves when the symbol and the name are both unknown", async () => {
    const orphan = ann({
      scripCode: "530127",
      symbol: "",
      company: "Kkalpana Industries India Ltd",
      newsId: "n-orphan",
    });
    const h = harness({
      announcements: [orphan],
      instrumentsByScripCode: new Map([
        ["530127", { id: "i-kk", symbol: "KKALPANAIN", exchange: "BSE" }],
      ]),
      instrumentsBySymbol: new Map(),
      instrumentsByNamePrefix: new Map(),
    });

    await processBseAnnouncementsSync({}, h.deps);

    assert.equal(h.upserts.length, 1, "the announcement was dropped unresolved");
    assert.equal(h.upserts[0]!.create.instrumentId, "i-kk");
    assert.equal(h.upserts[0]!.create.symbol, "KKALPANAIN");
    assert.equal(h.upserts[0]!.create.exchange, "BSE");
  });

  /**
   * THE CONTROL. Without it the case above passes for a processor that resolves
   * everything to a default instrument.
   */
  it("CONTROL: an unknown scrip code with an unknown symbol stays unresolved", async () => {
    const orphan = ann({
      scripCode: "999999",
      symbol: "",
      company: "Nobody Industries Ltd",
      newsId: "n-nobody",
    });
    const h = harness({
      announcements: [orphan],
      instrumentsByScripCode: new Map(),
      instrumentsBySymbol: new Map(),
      instrumentsByNamePrefix: new Map(),
    });

    await processBseAnnouncementsSync({}, h.deps);

    assert.deepEqual(h.upserts, [], "an unresolvable row was written anyway");
    assert.deepEqual(h.downloads, []);
  });

  it("the scrip code OUTRANKS the alpha symbol", async () => {
    // A rename leaves the two exchanges carrying different tickers for one
    // company (MONEY-1177), so an alpha symbol can point at a different issuer
    // where an exchange-issued identity cannot. If the rungs were reordered
    // this would silently file the announcement under the wrong company.
    const h = harness({
      announcements: [ann({ scripCode: "500325", symbol: "RELIANCE" })],
      instrumentsByScripCode: new Map([
        ["500325", { id: "i-scrip", symbol: "RELIANCE", exchange: "BSE" }],
      ]),
      instrumentsBySymbol: new Map([
        ["RELIANCE", { id: "i-symbol", symbol: "RELIANCE", exchange: "NSE" }],
      ]),
    });

    await processBseAnnouncementsSync({}, h.deps);

    assert.equal(h.upserts.length, 1);
    assert.equal(
      h.upserts[0]!.create.instrumentId,
      "i-scrip",
      "the alpha-symbol rung won over BSE's own identifier",
    );
  });

  it("a non-numeric scrip code is never queried", async () => {
    // The value goes into a database query and a URL-shaped identifier is a
    // parse artefact, not an identity. It must fall through, not be looked up.
    const asked: string[] = [];
    const h = harness({
      announcements: [
        ann({ scripCode: "N/A", symbol: "RELIANCE", newsId: "n-bad" }),
      ],
    });
    const deps: BseAnnouncementsSyncDeps = {
      ...h.deps,
      findInstrumentByScripCode: async (code) => {
        asked.push(code);
        return null;
      },
    };

    await processBseAnnouncementsSync({}, deps);

    assert.deepEqual(asked, [], "a non-numeric scrip code reached the query");
    assert.equal(h.upserts.length, 1, "the symbol rung did not take over");
  });
});
