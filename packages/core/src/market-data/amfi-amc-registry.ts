/**
 * AMFI's own registry of every Indian AMC, parsed out of the portfolio-disclosure page.
 *
 * MONEY-1105 (Data Engine P8a). Pure: HTML in, typed records out. No fetching,
 * no I/O, no Prisma — the worker owns all of that, exactly as
 * `amc-portfolio-sources.ts` owns URL construction and nothing else.
 *
 * ## Why this exists
 *
 * `amc-portfolio-sources.ts` is a HAND-CODED table of five AMCs, three of them
 * with a URL template we trust. India has 57. Hand-maintaining the other 52 —
 * their names, their disclosure pages, their identity — is a standing tax that
 * nobody pays on time, and the failure is silent: an AMC that renames a page is
 * indistinguishable from an AMC that has not published yet.
 *
 * AMFI already maintains that list, and publishes it machine-readably. This
 * module reads it. It deliberately stops at READING: it resolves no file URLs
 * and promises no fetchability. Whether a given AMC's monthly disclosure can
 * actually be downloaded is a separate, evidence-gated question that
 * `amc-portfolio-sources.ts` answers with its `provenance` field, and this
 * parser must not be mistaken for an answer to it. **A guessed URL 404s
 * identically to "not published yet"**, so the registry's landing-page links are
 * reported as what they are — links AMFI publishes — and nothing here upgrades
 * one to "fetchable".
 *
 * ## The one genuinely valuable field: `mfId`
 *
 * `mf_id` is AMFI's own authoritative AMC identifier and we have no other source
 * for it. It keys two AMFI endpoints directly:
 *
 *   https://portal.amfiindia.com/RssNAV.aspx?mf={mfId}            per-AMC scheme list
 *   https://portal.amfiindia.com/spages/sai{mfId}.pdf             statement of information
 *
 * ## And the field that quietly solves scheme identity: `fundName`
 *
 * P8a's hardest unsolved problem is that NO AMC portfolio file carries an AMFI
 * scheme code, so a sheet named "SBI Bluechip Fund" has to be matched to a
 * scheme by NAME against ~14,000 industry-wide schemes.
 *
 * `fundName` (AMFI's `mf_name`) is BYTE-IDENTICAL to the AMC group header in
 * `https://portal.amfiindia.com/spages/NAVAll.txt`, which
 * `instruments/amfi-mf-provider.ts` already ingests and which DOES carry scheme
 * codes and ISINs. Measured 2026-08-14: all 52 NAVAll AMC groups matched a
 * registry `mf_name` exactly, with zero unmatched groups on the NAVAll side.
 * The five registry rows with no NAVAll group (ASK, Carnelian, Lakshya, Monarch,
 * Nuvama) are newly-licensed AMCs with no live schemes — which is also why those
 * five are exactly the rows whose monthly-disclosure link is "".
 *
 * So `mfId -> fundName -> NAVAll group` narrows name-matching from ~14,273
 * schemes industry-wide to that one AMC's list (median 130 rows, collapsing to
 * ~123 scheme families for SBI against the 122 sheets in its actual workbook).
 * That join is the reason `fundName` is exposed verbatim and the reason
 * `findAmcByFundName` is an EXACT match — see the note on that function.
 *
 * ## How the data is embedded, and why the parser looks like this
 *
 * The page is a server-rendered Next.js app: HTTP 200 at 240,638 bytes, and the
 * AMC data is in the served bytes, so no browser and no JavaScript are needed.
 * It is also NOT User-Agent gated — measured 2026-08-14, curl's default UA and a
 * blank UA both returned the identical 240,638 bytes as a Chrome UA. Worth
 * stating because the neighbouring exchange feeds DO gate on UA, and copying
 * that ceremony here would add a dependency on a header nobody checks.
 *
 * The AMC list rides in the React Server Component payload, which ships as a
 * sequence of
 *
 *     <script>self.__next_f.push([1,"<js string literal>"])</script>
 *
 * chunks whose decoded bodies CONCATENATE into one RSC stream. Two consequences
 * drive the implementation:
 *
 *  1. **Decode before searching, and concatenate before parsing.** Chunk
 *     boundaries fall wherever Next.js flushed, not on anything meaningful, so
 *     a regex run over the raw HTML is matching against escaped text that may
 *     also be split mid-record. Every chunk is decoded and joined first.
 *
 *  2. **Decode the literal properly — do not hand-roll the unescape.** The
 *     obvious shortcut is `.replace(/\\"/g, '"')`. It is wrong, and wrong
 *     silently: Angel One's `amc_website` is `https:\\angelonemf.com` (AMFI
 *     typed backslashes for slashes), whose raw bytes carry `\\` escapes. A
 *     replace that handles `\"` but not `\\` returns that URL with its
 *     backslashes DOUBLED and no error anywhere. `JSON.parse` on the quoted
 *     literal handles `\"`, `\\`, `\n` and `\uXXXX` together, which is the whole
 *     escape alphabet the live page actually uses. The committed fixture pins
 *     this exact record.
 *
 * The key is matched as the literal token `"members":[` rather than by grepping
 * for `members`, because the same page contains the nav link
 * `/aboutamfi?tab=members`. The fixture keeps that decoy verbatim so a parser
 * that regresses to a loose match fails the test instead of finding zero AMCs.
 *
 * ## Failure mode: `null`, never `[]`
 *
 * An unrecognised page shape returns `null`. It must never return an empty
 * array, because "AMFI restructured the page" and "AMFI lists no AMCs" would
 * then be the same value — and the second is impossible, so a caller that saw
 * `[]` would treat a total parse failure as a legitimately empty result and log
 * a success. This is the same discipline as the `provenance` field next door:
 * make "we do not know" a distinct, loud value.
 */

/** The page the registry is parsed out of. Server-rendered; needs a browser UA. */
export const AMFI_AMC_REGISTRY_URL =
  "https://www.amfiindia.com/online-center/portfolio-disclosure";

/**
 * One AMC as AMFI describes it.
 *
 * Link fields are `null` when AMFI publishes nothing, which it represents as an
 * empty string. Collapsing `""` to `null` here means a caller cannot
 * accidentally build `fetch("")` out of a missing link — and the five AMCs that
 * currently have no monthly link are real, not a parse artefact.
 *
 * NOTE what a non-null link is and is not. It is the URL AMFI publishes for
 * that disclosure. It is NOT a promise that the URL serves a portfolio FILE —
 * for 49 of the 57 it is a landing page, and for some it is a file. Resolving a
 * landing page to a file is a separate, per-AMC, evidence-gated job.
 */
export interface AmfiAmcRecord {
  /**
   * AMFI's own AMC id, e.g. "22" for SBI. Authoritative and unavailable
   * elsewhere; keys `RssNAV.aspx?mf=` and `spages/sai{id}.pdf`. A STRING because
   * AMFI publishes it as one — it is an identifier, not a quantity, and nothing
   * good comes of arithmetic on it.
   */
  mfId: string;
  /**
   * The FUND name, e.g. "SBI Mutual Fund". Byte-identical to the AMC group
   * header in NAVAll.txt — preserved verbatim, because that exactness is the
   * entire value of the field.
   */
  fundName: string;
  /** The legal entity, e.g. "SBI Funds Management Limited". Differs from `fundName`. */
  legalName: string;
  website: string | null;
  /** The link this module exists for. Landing page for most AMCs; a file for a few. */
  monthlyPortfolioUrl: string | null;
  fortnightlyPortfolioUrl: string | null;
  halfYearlyPortfolioUrl: string | null;
  monthlyFactsheetUrl: string | null;
  schemeWiseAnnualReportUrl: string | null;
  /** `RssNAV.aspx?mf={mfId}` — that AMC's schemes with NAVs. Carries NO scheme codes. */
  rssNavUrl: string | null;
  rssAumUrl: string | null;
  statementOfInformationUrl: string | null;
}

export interface AmfiAmcRegistry {
  /** Source order preserved — AMFI publishes them alphabetically by fund name. */
  amcs: readonly AmfiAmcRecord[];
}

/**
 * What the registry's monthly link IS, judged only by its own shape.
 *
 * This DESCRIBES a published link. It does not predict that fetching it yields a
 * portfolio, and `"file"` is not a licence to fetch — Quantum's link is a direct
 * .xlsx behind an opaque GUID, so it is a file that still cannot be templated to
 * a month. Treat this as triage input for the per-AMC resolution work, never as
 * provenance.
 */
export type AmfiMonthlyLinkKind =
  /** AMFI publishes no monthly link for this AMC. */
  | "none"
  /** The link ends in a document/handler extension. */
  | "file"
  /** Anything else: a page a human (or a resolver) must read to find the file. */
  | "page";

/**
 * DOCUMENT extensions only — deliberately not script handlers.
 *
 * Three of the 57 monthly links end in something file-ish, and probing all
 * three on 2026-08-14 split them 1/2:
 *
 *   Quantum  …/FileCDN/FactSheet/5f6c4b6e-….xlsx   200, 952,771 B, real OOXML
 *   NJ       …/njmf_download.php?nme=127           200, 137,519 B, text/html
 *   IL&FS    …/other.php                           200, 716,085 B, text/html
 *
 * So `.php` is a HANDLER extension, not a document one: both observed instances
 * serve a landing page. Counting them as `"file"` would have reported 3 fetchable
 * files where there is 1, and the two wrong ones fail in the worst available
 * way — HTTP 200 with a body, so a fetcher stores 137 KB of HTML and every log
 * line reads as success. `.aspx`, `.jsp` and friends are excluded for the same
 * reason. Only extensions that cannot be anything but a document count here.
 */
const FILE_LIKE = /\.(xlsx?|zip|csv)(?:$|[?#])/i;

export function classifyMonthlyLink(
  record: AmfiAmcRecord,
): AmfiMonthlyLinkKind {
  const url = record.monthlyPortfolioUrl;
  if (url === null) return "none";
  return FILE_LIKE.test(url) ? "file" : "page";
}

/** The marker every RSC payload chunk opens with. */
const CHUNK_MARK = 'self.__next_f.push([1,"';

/** The exact key, with its `[`. Matching bare `members` hits `?tab=members`. */
const MEMBERS_KEY = '"members":[';

/**
 * Decode every `self.__next_f.push([1,"…"])` chunk and concatenate them.
 *
 * The scan walks the literal honouring backslash escapes so that an embedded
 * `\"` does not look like the closing quote — the payload is dense with them, so
 * a naive `indexOf('"')` truncates at the first URL. Decoding is delegated to
 * `JSON.parse` (see the header: hand-rolled unescaping loses `\\`).
 *
 * A chunk that fails to decode is skipped rather than fatal. The AMC list lives
 * in exactly one chunk, and the other twelve are page furniture; letting an
 * unrelated malformed chunk take down the parse would turn a cosmetic upstream
 * change into a data outage.
 */
function decodeRscStream(html: string): string {
  const chunks: string[] = [];
  let cursor = 0;

  for (;;) {
    const open = html.indexOf(CHUNK_MARK, cursor);
    if (open < 0) break;

    const bodyStart = open + CHUNK_MARK.length;
    let close = -1;
    for (let i = bodyStart; i < html.length; i++) {
      const ch = html[i];
      if (ch === "\\") {
        i++; // skip whatever this escapes, including a literal backslash
        continue;
      }
      if (ch === '"') {
        close = i;
        break;
      }
    }
    if (close < 0) break; // truncated document

    try {
      chunks.push(JSON.parse(`"${html.slice(bodyStart, close)}"`) as string);
    } catch {
      // Not a decodable literal. Skip it; another chunk may still hold the list.
    }
    cursor = close + 1;
  }

  return chunks.join("");
}

/**
 * Return the `[...]` starting at `open`, or null if it never closes.
 *
 * Bracket counting has to be string-aware: AMFI's own values contain brackets
 * (and Angel One's contains backslashes), so a counter that ignores strings
 * closes the array early and `JSON.parse` then fails on a truncated slice —
 * which would surface as "AMFI changed the page" rather than "our scanner is
 * wrong".
 */
function sliceBalancedArray(text: string, open: number): string | null {
  let depth = 0;
  let inString = false;

  for (let i = open; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }

  return null;
}

/** AMFI's raw record. Every field is optional because upstream owns the shape. */
interface RawAmfiRecord {
  readonly mf_id?: unknown;
  readonly mf_name?: unknown;
  readonly amc_name?: unknown;
  readonly amc_website?: unknown;
  readonly amc_monthly_portfolio_disclosure?: unknown;
  readonly amc_fortnightly_portfolio_disclosure?: unknown;
  readonly amc_halfYearly_portfolio_disclosure?: unknown;
  readonly amc_monthly_mf_factsheets?: unknown;
  readonly amc_schemewise_annual_report?: unknown;
  readonly rss_latest_nav?: unknown;
  readonly rss_latest_aum?: unknown;
  readonly statement_of_information?: unknown;
}

/** A link AMFI does not publish arrives as `""`; make that absence explicit. */
function link(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Identity fields are NOT trimmed and NOT normalised.
 *
 * `fundName` has to stay byte-identical to the NAVAll.txt group header for the
 * join described in the header to hold, and `mfId` is an opaque key. Tidying
 * either one is how an exact join silently becomes a 96%-exact join.
 */
function required(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toRecord(raw: RawAmfiRecord): AmfiAmcRecord | null {
  const mfId = required(raw.mf_id);
  const fundName = required(raw.mf_name);
  // `amc_name` is the only one that may legitimately be blank, so it falls back
  // to the fund name rather than rejecting an otherwise-good record.
  if (mfId === null || fundName === null) return null;

  return {
    mfId,
    fundName,
    legalName: required(raw.amc_name) ?? fundName,
    website: link(raw.amc_website),
    monthlyPortfolioUrl: link(raw.amc_monthly_portfolio_disclosure),
    fortnightlyPortfolioUrl: link(raw.amc_fortnightly_portfolio_disclosure),
    halfYearlyPortfolioUrl: link(raw.amc_halfYearly_portfolio_disclosure),
    monthlyFactsheetUrl: link(raw.amc_monthly_mf_factsheets),
    schemeWiseAnnualReportUrl: link(raw.amc_schemewise_annual_report),
    rssNavUrl: link(raw.rss_latest_nav),
    rssAumUrl: link(raw.rss_latest_aum),
    statementOfInformationUrl: link(raw.statement_of_information),
  };
}

/**
 * Parse AMFI's AMC registry out of the portfolio-disclosure page's HTML.
 *
 * Returns `null` — never `[]` — when the page does not have the expected shape,
 * so that "we could not read it" stays distinguishable from "there is nothing to
 * read". See the header for why that distinction is load-bearing.
 */
export function parseAmfiAmcRegistry(html: string): AmfiAmcRegistry | null {
  if (typeof html !== "string" || html.length === 0) return null;

  // The RSC path is how the live page ships. The raw-HTML fallback costs one
  // indexOf and covers AMFI moving to plain embedded JSON (a `__NEXT_DATA__`
  // blob, say) without the escaping layer — a shape change that would otherwise
  // read as a total outage despite the data still being right there.
  const stream = decodeRscStream(html);
  const source = stream.includes(MEMBERS_KEY) ? stream : html;

  const keyAt = source.indexOf(MEMBERS_KEY);
  if (keyAt < 0) return null;

  const arrayText = sliceBalancedArray(
    source,
    keyAt + MEMBERS_KEY.length - 1, // point at the `[`, not past it
  );
  if (arrayText === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const amcs: AmfiAmcRecord[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = toRecord(entry as RawAmfiRecord);
    if (record !== null) amcs.push(record);
  }

  // Found the key but recovered nothing usable: the shape moved under us. That
  // is a parse failure, not an empty registry — AMFI always lists AMCs.
  if (amcs.length === 0) return null;

  return { amcs };
}

/** Exact lookup by AMFI's AMC id. */
export function findAmcByMfId(
  registry: AmfiAmcRegistry,
  mfId: string,
): AmfiAmcRecord | undefined {
  return registry.amcs.find((a) => a.mfId === mfId);
}

/**
 * EXACT lookup by fund name. Deliberately not fuzzy, and not case-insensitive.
 *
 * The point of this function is the byte-exact join to NAVAll.txt's AMC group
 * header. Loosening it would make the lookup succeed more often while making the
 * thing it is used for — "these scheme codes belong to this AMC" — occasionally
 * wrong, and wrong in a way that produces plausible holdings attributed to the
 * wrong fund house. A miss here is information; a fuzzy hit is a liability.
 */
export function findAmcByFundName(
  registry: AmfiAmcRegistry,
  fundName: string,
): AmfiAmcRecord | undefined {
  return registry.amcs.find((a) => a.fundName === fundName);
}

/** The AMCs for which AMFI publishes any monthly-disclosure link at all. */
export function amcsWithMonthlyDisclosure(
  registry: AmfiAmcRegistry,
): AmfiAmcRecord[] {
  return registry.amcs.filter((a) => a.monthlyPortfolioUrl !== null);
}
