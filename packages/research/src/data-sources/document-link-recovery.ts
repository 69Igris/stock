/**
 * "The bytes are a web page — is the DOCUMENT one hop further in?" — MONEY-1321.
 *
 * ## The question this answers, and the measurement that shaped it
 *
 * MONEY-1315 found 1,573 `stock_documents` rows whose stored bytes are an HTML
 * page rather than a document, and proposed quarantining them. Before paying
 * for that, the pages we ALREADY HOLD were searched for a link to the real
 * file. Measured on prod 2026-09-02 across the full cohort (1,605 rows,
 * `sourceType: "SCREENER"` + `processingStatus: "UNSUPPORTED"`):
 *
 *     body is HTML          1,580        of which enveloped   1,064
 *     body is MPEG audio       13
 *     body is ZIP              12
 *
 * and, by the host of `sourceUrl`:
 *
 *     host                     rows   html   carries a link   median text
 *     www.sebi.gov.in           605    605        604              455
 *     www.crisil.com            442    442        434           17,177
 *     www.icra.in               186    186        186            4,853
 *     www.indiaratings.co.in    135    135          0               86
 *     www.bseindia.com           74     74          0            1,043
 *     bcrisp.in                  69     69         67           13,201
 *     connect.acuite.in           9      9          0           18,288
 *
 * ## THE TRAP: "carries a link" IS NOT "is recoverable"
 *
 * Reading 84% down that "carries a link" column as 84% recoverable is the
 * expensive mistake, and it is the reason this module is a per-host allowlist
 * rather than a generic "find the first `.pdf`" rule.
 *
 * On a SEBI page the link IS the document — the page is 455 characters of
 * chrome wrapped around one `<iframe>`. On a CRISIL page the links are
 * METHODOLOGY BOILERPLATE (`Basics of Ratings…pdf`, `Criteria for
 * manufacturing…pdf`, `CRISILs Approach to Financial Ratios.pdf`) and the
 * document is the 17,177 characters of rating rationale in the page itself.
 * A generic first-link parser would therefore replace 442 company rating
 * rationales with a handful of generic criteria PDFs — the wrong document,
 * stored confidently, with nothing in the row to reveal it. Same shape at
 * Brickwork (`bcrisp.in`), whose refs are all `Criteria-*.pdf`.
 *
 * So every rule below selects by ROLE — the viewer's own `file=` parameter —
 * never by "the first thing ending in .pdf".
 *
 * ## Why HTML-IS-THE-DOCUMENT is a verdict and not a failure
 *
 * For CRISIL, Brickwork and Acuite the stored bytes are the complete document;
 * `sourceUrl` for CRISIL literally ends in `.html`. Quarantining those rows
 * would DESTROY content we successfully fetched. They need a text extractor,
 * which is a different lane from the PDF one — so this returns a distinct
 * verdict rather than `null`, and the caller can route on it.
 *
 * ## What is genuinely unrecoverable, and why re-fetching will not fix it
 *
 * `indiaratings.co.in` (135) stores a JS shell — 86 characters of text, zero
 * links; the press release is rendered client-side. `bseindia.com` (74) stored
 * BSE's HOMEPAGE where a direct `.pdf` URL was requested, which is BSE's
 * cookieless/referer rejection, not a link-shape problem. Neither is a parser
 * fix; both are named here so nobody re-derives them as one.
 *
 * ## Who calls this, as of MONEY-1321
 *
 * It shipped with nobody calling it. Three readers now share its host taxonomy
 * and cannot drift from one another:
 *
 *   `scripts/migrations/recover-html-stock-documents.ts`  the backfill, both lanes
 *   `document-body-guard.ts#classifyDocumentRow`          the quarantine's exclusion
 *   {@link recoveryHostKind}                              the backfill's row narrowing
 *
 * That sharing is not tidiness. The quarantine DELETES (`gcsPath: ""`, and the
 * enrichment pipeline never revisits a cleared row) while the recovery SAVES,
 * so two copies of "which hosts publish the document as the page" that drifted
 * would have one job destroying what the other was written to preserve.
 *
 * PURE: no I/O, no clock, no randomness. It is handed a `sourceUrl` and the
 * page bytes and returns a decision; fetching whatever it names is the
 * caller's job.
 */

/** What can be done with a document row whose stored bytes are a web page. */
export type DocumentRecovery =
  | {
      kind: "document-url";
      /** Absolute URL of the real document. */
      url: string;
      why: string;
    }
  | {
      /** The stored HTML IS the document — extract text, do not chase a link. */
      kind: "html-is-the-document";
      why: string;
    }
  | {
      /** No document is reachable from these bytes. */
      kind: "unrecoverable";
      why: string;
    };

/**
 * Hosts whose page body is the document itself.
 *
 * Each was confirmed by median extracted-text length across its whole
 * population on prod (CRISIL 17,177 chars; Brickwork 13,201; Acuite 18,288) —
 * an order of magnitude above the 455 of a SEBI landing page and the 86 of an
 * India Ratings shell.
 */
const HTML_IS_THE_DOCUMENT_HOSTS: ReadonlySet<string> = new Set([
  "www.crisil.com",
  "crisil.com",
  "bcrisp.in",
  "www.bcrisp.in",
  "connect.acuite.in",
]);

/**
 * Hosts measured to store a shell no parser can rescue.
 *
 * Kept as an explicit list, with the reason attached, so that a future reader
 * gets "measured, client-rendered" instead of re-running the same scan.
 */
const KNOWN_SHELL_HOSTS: ReadonlyMap<string, string> = new Map([
  [
    "www.indiaratings.co.in",
    "client-rendered press release — 86 chars of text and zero links in the stored bytes",
  ],
  [
    "www.bseindia.com",
    "BSE served its homepage in place of the requested .pdf (cookieless/referer rejection), not a landing page",
  ],
]);

/**
 * Host of a URL, lower-cased; `""` when there is nothing parseable.
 *
 * EXPORTED, and it is the ONE spelling of this in the recovery path. Three had
 * started to appear — this module's private copy, `document-body-guard`'s
 * cross-host check, and the backfill's `recoveryHostOf` — and "same host" is
 * not a triviality here: it is the rule that stops a page naming an arbitrary
 * absolute URL from being fetched and stored under our symbol. Three copies of
 * a security-relevant comparison is the drift this whole module exists to
 * avoid, one level down.
 */
export function recoveryUrlHost(url: string | null | undefined): string {
  if (typeof url !== "string" || url.trim().length === 0) return "";
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  return recoveryUrlHost(url);
}

/**
 * Is this row's page the document itself?
 *
 * ## Why this is exported separately from {@link recoverDocumentUrl}
 *
 * MONEY-1321. The MONEY-1315 quarantine blanks `gcsPath` on every row whose
 * stored bytes are HTML, and 520 of those rows — CRISIL 442, Brickwork 69,
 * Acuité 9, measured on prod 2026-09-02 — are rating rationales whose bytes we
 * successfully fetched and still hold. Quarantining them DESTROYS content, and
 * it is the one outcome in this ticket with no path back: the enrichment
 * pipeline never revisits a cleared row.
 *
 * So the quarantine has to consult this rule, and it has only the row — a
 * `sourceUrl`, a `gcsPath` and a body sniff. It does not have, and must not
 * need, the page's markup: this verdict is decided ENTIRELY by the host, and a
 * `null`-returning call on an unread body would read as "not a rating agency".
 *
 * ONE set, TWO readers. `recoverDocumentUrl` calls this rather than testing the
 * set itself, so the quarantine's exclusion and the recovery's routing can
 * never disagree about which hosts are in it — which is exactly the drift that
 * would let one of them start deleting what the other is trying to save.
 *
 * A missing or unparseable `sourceUrl` is FALSE, deliberately: the safe answer
 * for "we cannot tell" is not "this is a rating page", because a wrong TRUE
 * here leaves a genuinely-empty row claiming a document forever, and that is
 * the failure MONEY-1315 exists to fix. The wrong FALSE is caught by the
 * measurement instead — every host in the population is known and named.
 */
export function isHtmlTheDocumentHost(
  sourceUrl: string | null | undefined,
): boolean {
  if (typeof sourceUrl !== "string" || sourceUrl.trim().length === 0) {
    return false;
  }
  return HTML_IS_THE_DOCUMENT_HOSTS.has(hostOf(sourceUrl));
}

/**
 * Every `src`/`href` value in the page, with its element, in document order.
 *
 * Both quoting styles are matched. That is not defensive tidiness: SEBI writes
 * the iframe with SINGLE quotes, so a `src="…"`-only extractor finds nothing
 * on all 605 of those pages and reports the cohort as unrecoverable.
 */
function attributeValues(html: string, tag: string, attr: string): string[] {
  const re = new RegExp(
    `<${tag}\\b[^>]*?\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "gi",
  );
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v.length > 0) out.push(v);
  }
  return out;
}

/**
 * Pull the `file=` parameter out of a PDF-viewer URL.
 *
 * Both spellings occur on SEBI, and the split is close to even — 335 relative
 * against 269 absolute across the 605 pages — so handling one and not the
 * other silently loses 45% of the population while looking like it works:
 *
 *     ../../../web/?file=/sebi_data/attachdocs/1475213188154.pdf
 *     ../../../web/?file=https://www.sebi.gov.in/sebi_data/attachdocs/mar-2026/…pdf
 *
 * ## `file=` MUST BE A WHOLE PARAMETER NAME — MONEY-1321 M11
 *
 * This was `candidate.indexOf("file=")`, a SUBSTRING search, and `profile=`
 * contains `file=` at index 3. So `/viewer?profile=public&doc=x.pdf` yielded
 * the parameter value `public`, which then absolutises against `sourceUrl` into
 * a plausible same-host URL that passes the cross-host check and is fetched —
 * the wrong document, stored confidently, which is the exact failure this whole
 * module is built to avoid. `datafile=`, `outfile=` and `logfile=` are the same
 * shape. The boundary is now explicit: start-of-string, `?`, or `&`.
 *
 * The value is NOT URI-decoded before being handed to `URL`: it is already a
 * path or an absolute URL, and decoding first would corrupt any legitimately
 * encoded character in a filename.
 */
function viewerFileParam(candidate: string): string | null {
  // Case-sensitive, as the substring search was — this fixes the boundary, not
  // the casing, and a real page's parameter is lower-case on both measured
  // hosts. `[^&#]*` reproduces the old split on `&` and `#`.
  const m = /(?:^|[?&])file=([^&#]*)/.exec(candidate);
  if (!m) return null;
  const value = m[1]!.trim();
  return value.length > 0 ? value : null;
}

function absolutise(value: string, base: string): string | null {
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

/** SEBI: the prospectus lives in the page's single `<iframe>` viewer. */
function recoverSebi(sourceUrl: string, html: string): DocumentRecovery {
  const candidates = [
    ...attributeValues(html, "iframe", "src"),
    ...attributeValues(html, "embed", "src"),
    ...attributeValues(html, "object", "data"),
  ];

  for (const c of candidates) {
    const param = viewerFileParam(c);
    const target = param ?? c;
    if (!/\.pdf(\?|#|$)/i.test(target)) continue;
    const abs = absolutise(target, sourceUrl);
    if (abs) {
      return {
        kind: "document-url",
        url: abs,
        why: param
          ? "SEBI viewer iframe `file=` parameter"
          : "SEBI iframe pointing directly at the attachment",
      };
    }
  }

  // A handful of SEBI pages link the abridged prospectus directly.
  for (const href of attributeValues(html, "a", "href")) {
    if (!/\/sebi_data\/.*\.pdf(\?|#|$)/i.test(href)) continue;
    const abs = absolutise(href, sourceUrl);
    if (abs) {
      return {
        kind: "document-url",
        url: abs,
        why: "direct link into /sebi_data/",
      };
    }
  }

  return {
    kind: "unrecoverable",
    why: "SEBI page with no viewer iframe and no /sebi_data/ link",
  };
}

/** The numeric `Id` a `www.icra.in` rationale URL identifies itself by. */
function icraRationaleId(sourceUrl: string): string | null {
  try {
    const id = new URL(sourceUrl).searchParams.get("Id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * ICRA: the rationale PDF is behind the page's own PDF.js viewer.
 *
 * The page ALSO carries four boilerplate attachments — `Annexure I_SEBI.pdf`,
 * `Annexure II_FSR.pdf`, `ICRA Limited - POSH ICC Details.pdf` — which appear
 * on every rationale regardless of company. Selecting "the first .pdf" returns
 * one of those. The rationale is identified by ROLE: it is the target of
 * `/web/viewer.html?file=…`, and its id equals the `Id` already in `sourceUrl`.
 *
 * ## THE CORRESPONDENCE IS NOW CHECKED, NOT JUST CLAIMED — MONEY-1321 M12
 *
 * That last sentence was in this docstring and nowhere in the code: the loop
 * took the FIRST viewer link BY POSITION and never compared its id to the one
 * in `sourceUrl`. Selecting by role is only as strong as the role test, and
 * "first in document order" is not a role — one extra viewer link on a related
 * rationale, or a reordered template, and we store another company's document
 * under this symbol with nothing in the row to reveal it. That is the same
 * failure the CRISIL boilerplate trap describes, one level in.
 *
 * MEASURED on prod 2026-09-02 across all 196 ICRA rows before enforcing it, so
 * the check is known not to narrow anything: 10 have no readable bytes, 125
 * carry NO viewer link at all (they already reached the `Id` fallback below),
 * and the remaining 61 carry EXACTLY ONE viewer link whose `file=` contains
 * their own `Id`. Zero mismatches, zero pages with a second viewer link. So
 * today the check changes no verdict — it removes the way this goes wrong
 * later, when a page shape moves.
 *
 * When an `Id` is present and no viewer link corresponds to it, the derived
 * `/Rating/ShowRationalReportFilePdf/<Id>` wins over an uncorroborated link:
 * that URL is built FROM the row's own identity and cannot belong to another
 * company. A link we cannot tie to this page is not evidence.
 */
function recoverIcra(sourceUrl: string, html: string): DocumentRecovery {
  const id = icraRationaleId(sourceUrl);
  const viewerTargets = [
    ...attributeValues(html, "a", "href"),
    ...attributeValues(html, "iframe", "src"),
  ]
    .filter((href) => /viewer\.html\?/i.test(href))
    .map((href) => viewerFileParam(href))
    .filter((param): param is string => param !== null);

  if (id !== null) {
    // `\D` on both sides so `139291` does not match inside `1392910`.
    const idPattern = new RegExp(`(^|\\D)${id}(\\D|$)`);
    const corroborated = viewerTargets.find((t) => idPattern.test(t));
    if (corroborated !== undefined) {
      const abs = absolutise(corroborated, sourceUrl);
      if (abs) {
        return {
          kind: "document-url",
          url: abs,
          why: "ICRA PDF.js viewer `file=` whose id matches the source URL's `Id`",
        };
      }
    }
    const abs = absolutise(
      `/Rating/ShowRationalReportFilePdf/${id}`,
      sourceUrl,
    );
    if (abs) {
      return {
        kind: "document-url",
        url: abs,
        why:
          viewerTargets.length === 0
            ? "derived from the `Id` in the source URL"
            : "derived from the `Id` in the source URL — no viewer link on the " +
              "page corresponds to it, and an uncorroborated link may be another " +
              "company's rationale",
      };
    }
  }

  // No `Id` to corroborate against. A viewer link is still selected by ROLE and
  // is the only evidence available, so it is used — but it can never displace a
  // correspondence, because that branch already returned.
  for (const target of viewerTargets) {
    const abs = absolutise(target, sourceUrl);
    if (abs) {
      return {
        kind: "document-url",
        url: abs,
        why: "ICRA PDF.js viewer `file=` parameter (no `Id` in the source URL to corroborate)",
      };
    }
  }

  return {
    kind: "unrecoverable",
    why: "ICRA page with no viewer link and no Id",
  };
}

/**
 * Hosts whose page LINKS to the document — the one-hop lane.
 *
 * An explicit table beside the other two, so the complete host taxonomy is
 * three adjacent constants rather than a chain of `if`s a reader has to
 * assemble from the bottom of the file.
 */
const ONE_HOP_HOSTS: ReadonlyMap<
  string,
  (sourceUrl: string, html: string) => DocumentRecovery
> = new Map([
  ["www.sebi.gov.in", recoverSebi],
  ["sebi.gov.in", recoverSebi],
  ["www.icra.in", recoverIcra],
  ["icra.in", recoverIcra],
]);

/** Which lane a row belongs to, decided from the HOST alone. */
export type RecoveryHostKind = "one-hop" | "html-is-the-document" | "none";

/**
 * What the HOST alone says a row's lane is — MONEY-1321.
 *
 * ## Why the host has to answer this WITHOUT the page
 *
 * The recovery backfill walks 88,000 rows and must decide which are worth a
 * GCS read BEFORE spending one. Calling {@link recoverDocumentUrl} with an
 * empty body cannot do that job, and fails in the direction that looks like it
 * works: for a SEBI or ICRA row the BODY carries the viewer link, so an empty
 * body yields `unrecoverable` and the narrowing silently drops all 790 one-hop
 * rows — while the 520 text rows, which short-circuit on host, keep routing
 * perfectly. A filter that is right about the class it is easiest to check.
 *
 * So the LANE comes from the host and the URL comes from the body: two
 * questions, two inputs, and only the second needs bytes.
 *
 * ONE host taxonomy, THREE readers — this, {@link recoverDocumentUrl} and
 * {@link isHtmlTheDocumentHost} — so the quarantine's exclusion, the
 * backfill's narrowing and the recovery's routing cannot drift apart.
 */
export function recoveryHostKind(
  sourceUrl: string | null | undefined,
): RecoveryHostKind {
  if (typeof sourceUrl !== "string" || sourceUrl.trim().length === 0) {
    return "none";
  }
  const host = hostOf(sourceUrl);
  if (host.length === 0) return "none";
  if (HTML_IS_THE_DOCUMENT_HOSTS.has(host)) return "html-is-the-document";
  if (KNOWN_SHELL_HOSTS.has(host)) return "none";
  return ONE_HOP_HOSTS.has(host) ? "one-hop" : "none";
}

/**
 * Decide what can be done with a stored page.
 *
 * `sourceUrl` is the row's own column and is the ONLY thing that selects a
 * rule. Sniffing the page for a vendor signature instead would let one
 * upstream's page shape be applied to another's — which is exactly how a
 * CRISIL rationale would acquire a SEBI reading.
 */
export function recoverDocumentUrl(args: {
  sourceUrl: string;
  html: string;
}): DocumentRecovery {
  const host = hostOf(args.sourceUrl);
  if (host.length === 0) {
    return { kind: "unrecoverable", why: "sourceUrl is not a parseable URL" };
  }

  // Through the exported predicate, never the set directly — see
  // `isHtmlTheDocumentHost` for why one reader must not be able to drift from
  // the other.
  if (isHtmlTheDocumentHost(args.sourceUrl)) {
    return {
      kind: "html-is-the-document",
      why: `${host} publishes the rationale as the page itself — its .pdf links are methodology boilerplate`,
    };
  }

  const shell = KNOWN_SHELL_HOSTS.get(host);
  if (shell !== undefined) {
    return { kind: "unrecoverable", why: `${host}: ${shell}` };
  }

  const oneHop = ONE_HOP_HOSTS.get(host);
  if (oneHop) return oneHop(args.sourceUrl, args.html);

  return {
    kind: "unrecoverable",
    why: `no measured rule for ${host} — a guessed rule here would store the wrong document`,
  };
}
