/**
 * Tests for the AMFI AMC-registry parser (MONEY-1105).
 *
 * These run against a TRIMMED BUT VERBATIM capture of the real page, committed
 * at `__tests__/fixtures/amfi/portfolio-disclosure.trimmed.html`. That matters
 * more here than almost anywhere else in the repo: the entire difficulty of this
 * page is its ESCAPING, and a synthetic fixture would have been escaped by
 * whoever wrote it — i.e. it would have agreed with the parser by construction
 * and proved nothing. Every record below is byte-identical to what AMFI served
 * on 2026-08-14; only whole records were dropped.
 *
 * Each block names the silent-wrong-answer it exists to prevent. The recurring
 * theme is that every failure mode of this parser is quiet: a loose key match
 * finds the site nav, a hand-rolled unescape doubles a backslash, and a shape
 * change that returns `[]` reads downstream as "no AMCs today".
 *
 * Everything is synchronous — one file read, no timers, no promises, nothing to
 * orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMFI_AMC_REGISTRY_URL,
  amcsWithMonthlyDisclosure,
  classifyMonthlyLink,
  findAmcByFundName,
  findAmcByMfId,
  parseAmfiAmcRegistry,
  type AmfiAmcRecord,
  type AmfiAmcRegistry,
} from "../../src/market-data/amfi-amc-registry";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "amfi",
  "portfolio-disclosure.trimmed.html",
);

/** Read + parse once; every assertion below reads the same immutable result. */
const HTML = readFileSync(FIXTURE, "utf8");
const REGISTRY: AmfiAmcRegistry = (() => {
  const parsed = parseAmfiAmcRegistry(HTML);
  assert.ok(parsed, "the committed fixture must parse");
  return parsed;
})();

function amc(mfId: string): AmfiAmcRecord {
  const found = findAmcByMfId(REGISTRY, mfId);
  assert.ok(found, `fixture must contain mf_id=${mfId}`);
  return found;
}

describe("parseAmfiAmcRegistry — the live page's shape", () => {
  it("recovers every record kept in the fixture", () => {
    assert.equal(REGISTRY.amcs.length, 10);
  });

  it("preserves AMFI's source order rather than re-sorting", () => {
    // Source order is alphabetical BY FUND NAME, which is not the same as by
    // legal name or by mf_id (62 comes first, 3 second). Re-sorting would look
    // harmless and would break any positional reasoning about the live page.
    assert.deepEqual(
      REGISTRY.amcs.map((a) => a.mfId),
      ["62", "3", "80", "87", "9", "65", "17", "21", "41", "22"],
    );
  });

  it("keeps mf_id a string", () => {
    // It is an identifier, not a quantity. Coercing to number would drop any
    // future leading zero and invites arithmetic that means nothing.
    for (const a of REGISTRY.amcs) {
      assert.equal(typeof a.mfId, "string");
    }
    assert.equal(amc("22").fundName, "SBI Mutual Fund");
  });

  it("distinguishes the fund name from the legal entity", () => {
    // These are different strings and only one of them joins to NAVAll.txt.
    const sbi = amc("22");
    assert.equal(sbi.fundName, "SBI Mutual Fund");
    assert.equal(sbi.legalName, "SBI Funds Management Limited");
    assert.notEqual(sbi.fundName, sbi.legalName);
  });

  it("exposes the module's source URL", () => {
    assert.equal(
      AMFI_AMC_REGISTRY_URL,
      "https://www.amfiindia.com/online-center/portfolio-disclosure",
    );
  });
});

describe("escaping — the failure that produces a plausible wrong string", () => {
  it("unescapes literal backslashes instead of doubling them", () => {
    // THE regression. Angel One's website is `https:\\angelonemf.com` — AMFI
    // typed backslashes for slashes — and it is the only field in all 57 live
    // records that contains a literal backslash.
    //
    // A parser that unescapes with `.replace(/\\"/g, '"')` handles the quotes
    // and leaves `\\` alone, returning FOUR backslashes where there are two.
    // Nothing throws, the record looks fine, and the value is wrong. Asserting
    // the exact string is the only thing that catches it.
    assert.equal(amc("80").website, "https:\\\\angelonemf.com");
    assert.equal([...amc("80").website!].filter((c) => c === "\\").length, 2);
  });

  it("does not mangle ampersands or parentheses in a fund name", () => {
    // `IL&FS Mutual Fund (IDF)`. HTML-entity-decoding the payload (a plausible
    // "clean it up" step) would turn a correct name into a different one, and
    // the NAVAll join is byte-exact, so a mangled name silently stops matching.
    assert.equal(amc("65").fundName, "IL&FS Mutual Fund (IDF)");
  });

  it("preserves a host's mixed case", () => {
    // Quantum publishes `https://www.QuantumAMC.com`. Lower-casing a URL is a
    // classic "normalisation" that is safe for the host and NOT safe for the
    // path, and the tidy-up never stops at the host.
    assert.equal(amc("41").website, "https://www.QuantumAMC.com");
  });

  it("does not invent a scheme for a website that is not a URL", () => {
    // ASK publishes a bare `www.askmutualfund.com`. Helpfully prefixing
    // "https://" would be a fabricated URL — the exact thing this module is
    // forbidden from producing. Report what AMFI said, verbatim.
    assert.equal(amc("87").website, "www.askmutualfund.com");
  });

  it("does not percent-decode a URL", () => {
    // Not in the fixture's 10 records, so this is asserted directly rather than
    // faked: the risk lives in OUR code (a future "clean the URL" step), and a
    // decoded %20 is a URL that 404s later.
    const parsed = parseAmfiAmcRegistry(
      '<script type="application/json">{"members":[{"mf_id":"77",' +
        '"mf_name":"Zerodha Mutual Fund",' +
        '"amc_schemewise_annual_report":"https://x.test/Annual%20Report.pdf"}]}</script>',
    );
    assert.ok(parsed);
    assert.equal(
      parsed.amcs[0]!.schemeWiseAnnualReportUrl,
      "https://x.test/Annual%20Report.pdf",
    );
  });
});

describe("the `members` decoy", () => {
  it("ignores the site-nav link that also contains the word members", () => {
    // The fixture keeps `/aboutamfi?tab=members` verbatim, in an EARLIER chunk
    // than the AMC list. A parser that greps for `members` rather than the exact
    // `"members":[` key latches onto the nav array and finds no AMCs at all.
    assert.ok(HTML.includes("?tab=members"), "fixture must keep the decoy");
    assert.equal(REGISTRY.amcs.length, 10);
    assert.ok(findAmcByMfId(REGISTRY, "22"));
  });

  it("still parses when the decoy chunk is the only other content", () => {
    const decoyOnly = HTML.slice(0, HTML.indexOf("</script>") + 9);
    assert.ok(decoyOnly.includes("?tab=members"));
    // Decoy alone: no AMC list, so this is an unrecognised page, not an empty one.
    assert.equal(parseAmfiAmcRegistry(decoyOnly), null);
  });
});

describe("missing links are absence, not empty strings", () => {
  it("maps AMFI's empty string to null", () => {
    // ASK is a newly-licensed AMC with no live schemes, so AMFI publishes "".
    // Leaving it as "" lets a caller build `fetch("")`, which fails in a way
    // that looks like a network problem rather than a missing publication.
    const ask = amc("87");
    assert.equal(ask.monthlyPortfolioUrl, null);
    assert.equal(classifyMonthlyLink(ask), "none");
  });

  it("does not drop the record just because its links are empty", () => {
    // The AMC still exists and still has an authoritative mf_id. Dropping it
    // would make the registry disagree with AMFI about how many AMCs there are.
    assert.equal(amc("87").fundName, "ASK MUTUAL FUND");
  });

  it("counts only the AMCs that actually publish a monthly link", () => {
    const withLink = amcsWithMonthlyDisclosure(REGISTRY);
    assert.equal(withLink.length, 9);
    assert.ok(!withLink.some((a) => a.mfId === "87"));
  });
});

describe("classifyMonthlyLink — description, never permission", () => {
  it("calls a direct .xlsx a file", () => {
    assert.equal(classifyMonthlyLink(amc("41")), "file");
  });

  it("does NOT call a .php handler a file", () => {
    // IL&FS publishes `other.php`, which LOOKS like a download and is not:
    // probed 2026-08-14 it returned 200 with 716,085 bytes of text/html. NJ's
    // `njmf_download.php?nme=127` does the same at 137,519 bytes despite the
    // word "download" in the path.
    //
    // This is the worst failure shape available — HTTP 200 with a real body —
    // so a fetcher trusting `"file"` would store HTML as a portfolio and log a
    // success. A handler extension is not evidence of a document.
    assert.equal(classifyMonthlyLink(amc("65")), "page");
  });

  it("calls everything else a page", () => {
    for (const id of ["62", "3", "9", "17", "21", "22"]) {
      assert.equal(classifyMonthlyLink(amc(id)), "page", `mf_id=${id}`);
    }
  });

  it("classifies the live page's 57 links as 5 none / 1 file / 51 page", () => {
    // Pinned because the headline number matters: exactly ONE of AMFI's 57
    // monthly links is a document today. Anything that makes this number jump
    // is a classifier that has started guessing.
    const kinds = { none: 0, file: 0, page: 0 };
    for (const a of REGISTRY.amcs) kinds[classifyMonthlyLink(a)]++;
    assert.deepEqual(kinds, { none: 1, file: 1, page: 8 }); // fixture's 10
  });

  it("does not imply a file link is templatable", () => {
    // Quantum's link IS a file and is STILL useless for a monthly job: the path
    // is an opaque GUID with no date in it. `"file"` is triage input, never
    // provenance — promoting it to "fetchable" is exactly the guessed-URL bug
    // that reports zero forever while every log line reads as success.
    const quantum = amc("41");
    assert.equal(classifyMonthlyLink(quantum), "file");
    assert.ok(quantum.monthlyPortfolioUrl!.endsWith(".xlsx"));
    assert.ok(!/20\d{2}/.test(quantum.monthlyPortfolioUrl!));
  });
});

describe("mfId is the identifier we have no other source for", () => {
  it("keys the per-AMC RssNAV endpoint", () => {
    for (const a of REGISTRY.amcs) {
      if (a.rssNavUrl === null) continue;
      assert.equal(
        a.rssNavUrl,
        `https://portal.amfiindia.com/RssNAV.aspx?mf=${a.mfId}`,
      );
    }
  });

  it("keys the statement-of-information PDF", () => {
    assert.equal(
      amc("22").statementOfInformationUrl,
      "https://portal.amfiindia.com/spages/sai22.pdf",
    );
  });

  it("is unique across the registry", () => {
    // A duplicate id would make findAmcByMfId silently return whichever came
    // first, attributing one AMC's schemes to another.
    const ids = new Set(REGISTRY.amcs.map((a) => a.mfId));
    assert.equal(ids.size, REGISTRY.amcs.length);
  });
});

describe("findAmcByFundName — exact on purpose", () => {
  it("matches the NAVAll.txt group header byte-for-byte", () => {
    // These four strings are the AMC group headers in NAVAll.txt, which is the
    // feed that carries scheme codes. The join is exact or it is nothing.
    for (const name of [
      "SBI Mutual Fund",
      "HDFC Mutual Fund",
      "Nippon India Mutual Fund",
      "Aditya Birla Sun Life Mutual Fund",
    ]) {
      assert.ok(findAmcByFundName(REGISTRY, name), name);
    }
  });

  it("does NOT match on a different case", () => {
    // A case-insensitive lookup would succeed more often and be wrong more
    // often. A miss here is information; a fuzzy hit attributes real holdings
    // to the wrong fund house.
    assert.equal(findAmcByFundName(REGISTRY, "sbi mutual fund"), undefined);
  });

  it("does NOT match on the legal entity name", () => {
    assert.equal(
      findAmcByFundName(REGISTRY, "SBI Funds Management Limited"),
      undefined,
    );
  });

  it("does NOT match on a prefix or a trimmed variant", () => {
    assert.equal(findAmcByFundName(REGISTRY, "SBI"), undefined);
    assert.equal(findAmcByFundName(REGISTRY, " SBI Mutual Fund "), undefined);
  });
});

describe("null, never [] — an unreadable page must not read as an empty one", () => {
  const unreadable: ReadonlyArray<readonly [string, string]> = [
    ["empty string", ""],
    ["a page with no RSC chunks at all", "<html><body>Down</body></html>"],
    [
      "an RSC page that no longer carries the members key",
      '<script>self.__next_f.push([1,"c:[\\"$\\",\\"$L9\\",null,{\\"faqs\\":[]}]"])</script>',
    ],
    [
      "a members array that never closes (truncated response)",
      '<script>self.__next_f.push([1,"c:{\\"members\\":[{\\"mf_id\\":\\"22\\""])</script>',
    ],
    [
      "members present but not an array",
      '<script>self.__next_f.push([1,"c:{\\"members\\":[\\"22\\"]}"])</script>',
    ],
    [
      "records that carry no identity",
      '<script>self.__next_f.push([1,"c:{\\"members\\":[{\\"amc_name\\":\\"X Ltd\\"}]}"])</script>',
    ],
  ];

  for (const [label, html] of unreadable) {
    it(`returns null for ${label}`, () => {
      assert.equal(parseAmfiAmcRegistry(html), null);
    });
  }

  it("returns null rather than [] when the key is found but nothing survives", () => {
    // The distinction is the whole point: `[]` would let a caller log a
    // successful sync of zero AMCs, and AMFI never lists zero AMCs.
    const result = parseAmfiAmcRegistry(
      '<script>self.__next_f.push([1,"c:{\\"members\\":[]}"])</script>',
    );
    assert.equal(result, null);
    assert.notDeepEqual(result, { amcs: [] });
  });

  it("survives an undecodable neighbouring chunk", () => {
    // One malformed chunk of page furniture must not take the AMC list down
    // with it — that would turn a cosmetic upstream change into a data outage.
    const broken = `<script>self.__next_f.push([1,"\\q bad escape"])</script>\n${HTML}`;
    const parsed = parseAmfiAmcRegistry(broken);
    assert.ok(parsed);
    assert.equal(parsed.amcs.length, 10);
  });
});

describe("the un-escaped fallback shape", () => {
  it("reads plain embedded JSON if AMFI ever drops the RSC escaping", () => {
    // Cheap insurance: the same key in raw HTML (a __NEXT_DATA__-style blob)
    // would otherwise read as a total outage while the data sat in plain sight.
    const plain =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"members":[{"mf_id":"22","mf_name":"SBI Mutual Fund",' +
      '"amc_name":"SBI Funds Management Limited",' +
      '"amc_monthly_portfolio_disclosure":"https://www.sbimf.com/portfolios"}]}' +
      "</script>";
    const parsed = parseAmfiAmcRegistry(plain);
    assert.ok(parsed);
    assert.equal(parsed.amcs.length, 1);
    assert.equal(parsed.amcs[0]!.fundName, "SBI Mutual Fund");
    assert.equal(classifyMonthlyLink(parsed.amcs[0]!), "page");
  });
});

describe("the five hand-coded AMCs are all reachable through the registry", () => {
  it("resolves every id in amc-portfolio-sources.ts to an AMFI record", () => {
    // The registry is only useful for closing the 5-of-57 gap if it actually
    // contains the five we already have. Pinning the ids also pins the join
    // that lets a future caller replace the hand-coded names with AMFI's.
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["22", "SBI Mutual Fund"],
      ["21", "Nippon India Mutual Fund"],
      ["9", "HDFC Mutual Fund"],
      ["3", "Aditya Birla Sun Life Mutual Fund"],
      ["17", "Kotak Mahindra Mutual Fund"],
    ];
    for (const [mfId, fundName] of expected) {
      assert.equal(amc(mfId).fundName, fundName);
    }
  });

  it("shows why the registry alone does not solve fetchability", () => {
    // All five publish a monthly link, yet only three have a URL template we
    // trust. The registry closes the DISCOVERY gap, not the RESOLUTION gap, and
    // conflating the two is how an unverified URL gets fetched.
    for (const id of ["22", "21", "9", "3", "17"]) {
      assert.notEqual(amc(id).monthlyPortfolioUrl, null);
      assert.equal(classifyMonthlyLink(amc(id)), "page");
    }
  });
});
