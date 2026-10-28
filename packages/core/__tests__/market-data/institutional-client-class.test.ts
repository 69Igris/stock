/**
 * MONEY-268 — institutional client classification, against CAPTURED prod names.
 *
 * The fixture is 400 real `institutional_deals.clientName` values pulled from
 * prod on 2026-08-19 (see the header inside the .tsv). That matters more than
 * the case count: a hand-written fixture exercises only the strings its author
 * already had in mind, so it proves the classifier self-consistent and nothing
 * else. Every rule the module implements was forced by a string in this file,
 * and this suite pins each of them to the exact string that forced it.
 *
 * Three layers:
 *
 *   1. **Fixture integrity** — if the .tsv stops parsing, everything below goes
 *      vacuously green. Asserted first.
 *   2. **Named traps**, each a verbatim prod string: substring collisions,
 *      both-class conflicts, the retired markers, the weak-marker veto.
 *   3. **Whole-corpus invariants** — the distribution, and the property that
 *      the classifier never claims more than the markers support.
 *
 * ESM (`import.meta.dirname`) — this is `@usemoney/core`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyInstitutionalClient,
  institutionalClassLabel,
  tokenizeClientName,
  DII_MARKERS,
  FII_MARKERS,
  INDIAN_FORM_TOKENS,
  RETIRED_MARKERS,
  STRONG_FII_MARKERS,
  WEAK_FII_MARKERS,
  type InstitutionalClientClass,
} from "../../src/market-data/institutional-client-class";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "institutional-clients",
  "prod-client-names-2026-08-19.tsv",
);

interface CapturedName {
  prints: number;
  buys: number;
  sells: number;
  name: string;
}

function loadCaptured(): CapturedName[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((line) => {
      const [prints, buys, sells, ...rest] = line.split("\t");
      return {
        prints: Number(prints),
        buys: Number(buys),
        sells: Number(sells),
        // Re-join: a client name could itself contain a tab. None do today,
        // but splitting on the first three columns rather than taking [3] is
        // what keeps that from silently truncating a name.
        name: rest.join("\t"),
      };
    });
}

const captured = loadCaptured();
const names = captured.map((c) => c.name);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fixture integrity — every assertion below depends on this.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — captured fixture integrity", () => {
  it("parses 400 real names with plausible print counts", () => {
    assert.equal(
      captured.length,
      400,
      "the capture is 400 rows — a different count means the file was edited " +
        "or re-captured, and every distribution assertion below must be re-derived",
    );
    for (const c of captured) {
      assert.ok(c.name.length > 0, "empty clientName in the fixture");
      assert.ok(
        Number.isInteger(c.prints) && c.prints > 0,
        `bad print count for ${c.name}`,
      );
      assert.equal(
        c.buys + c.sells,
        c.prints,
        `${c.name}: buys+sells must reconcile to prints`,
      );
    }
  });

  it("the names are DISTINCT — the capture grouped by clientName", () => {
    assert.equal(new Set(names).size, names.length);
  });

  it("carries the strings this suite names below", () => {
    // A capture that lost the traps would make the trap cases pass against
    // literals rather than against data. Prove they are in the file.
    for (const trap of [
      "GRAVITON RESEARCH CAPITAL LLP",
      "NORGES BANK ON ACCOUNT OF THE GOVERNMENT PENSION FUND GLOBAL",
      "RAJASTHAN GLOBAL SECURITIES PVT LTD",
      "ARIHANT CAPITAL MARKETS LIMITED",
      "CITIGROUP GLOBAL MARKETS MAURITIUS PVT LTD",
      "GOLDMAN SACHS BANK EUROPESE-ODI",
    ]) {
      assert.ok(names.includes(trap), `fixture no longer contains: ${trap}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tokenisation.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — tokenizeClientName", () => {
  it("pads, upcases, and collapses every separator NSE actually uses", () => {
    assert.equal(
      tokenizeClientName("GOLDMAN SACHS BANK EUROPESE-ODI"),
      " GOLDMAN SACHS BANK EUROPESE ODI ",
    );
    assert.equal(
      tokenizeClientName(
        "PZENA VALUE FUNDS PLC/PZENA EMERGING MARKETS VALUE FUND",
      ),
      " PZENA VALUE FUNDS PLC PZENA EMERGING MARKETS VALUE FUND ",
    );
    assert.equal(
      tokenizeClientName("YUGA STOCKS AND COMMODITIES PRIVATE LIMITED  ."),
      " YUGA STOCKS AND COMMODITIES PRIVATE LIMITED ",
    );
    assert.equal(tokenizeClientName("ubs ag"), " UBS AG ");
  });

  it("keeps digits — they separate tokens the file wrote separately", () => {
    assert.equal(
      tokenizeClientName("ABS DIRECT EQUITY FUND LLC - INDIA SERIES 1"),
      " ABS DIRECT EQUITY FUND LLC INDIA SERIES 1 ",
    );
  });

  it("an all-punctuation or empty name tokenises to '' and classifies as unknown", () => {
    assert.equal(tokenizeClientName(""), "");
    assert.equal(tokenizeClientName("   "), "");
    assert.equal(tokenizeClientName("--.--"), "");
    assert.equal(classifyInstitutionalClient(""), "INSTITUTIONAL");
    assert.equal(classifyInstitutionalClient("   "), "INSTITUTIONAL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The traps — every one a verbatim prod string.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — substring collisions are NOT matches", () => {
  // 33 of the 400 names contain the literal substring "LP". Two are the marker.
  it("[regression] LLP is an Indian form, not the FII marker LP", () => {
    for (const domestic of [
      "GRAVITON RESEARCH CAPITAL LLP",
      "QE SECURITIES LLP",
      "XTX MARKETS LLP",
      "MATHISYS ADVISORS LLP",
      "PLUTUS WEALTH MANAGEMENT LLP",
      "BLITZQUANT RESEARCH LLP",
    ]) {
      assert.equal(
        classifyInstitutionalClient(domestic),
        "INSTITUTIONAL",
        `${domestic} was classified FII — "LP" is matching inside "LLP"`,
      );
    }
  });

  it("[regression] LP inside an ordinary word is not a match either", () => {
    for (const name of [
      "ALPHA LEON ENTERPRISES LLP",
      "BULLPULSE MARKETEDGE PRIVATE LIMITED",
      "ALPHAGREP SECURITIES PRIVATE LIMITED",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "INSTITUTIONAL", name);
    }
  });

  it("a real LP suffix IS the marker", () => {
    assert.equal(classifyInstitutionalClient("GHISALLO MASTER FUND LP"), "FII");
    assert.equal(
      classifyInstitutionalClient(
        "BBH GQG PARTNERS EMERGING MARKETS EQUITY MASTER FUND LP",
      ),
      "FII",
    );
  });

  it("[regression] COMMODITIES and FIRODIA do not contain the ODI marker", () => {
    for (const name of [
      "PRRSAAR COMMODITIES PVT LTD",
      "DIPAN MEHTA COMMODITIES PRIVATE LIMITED",
      "ACHINTYA COMMODITIES PRIVATE LIMITED",
      "ABHAYKUMAR NAVALMAL FIRODIA",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "INSTITUTIONAL", name);
    }
  });

  it("the ODI suffix IS the marker, however NSE punctuates it", () => {
    for (const name of [
      "SOCIETE GENERALE - ODI",
      "BOFA SECURITIES EUROPE SA - ODI",
      "GOLDMAN SACHS BANK EUROPESE-ODI",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "FII", name);
    }
  });

  it("[regression] TRANSGLOBAL / GLOBALWORTH are not GLOBAL", () => {
    for (const name of [
      "TRANSGLOBAL SECURITIES LTD",
      "GLOBALWORTH SECURITIES LIMITED",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "INSTITUTIONAL", name);
    }
  });
});

describe("MONEY-268 — a name matching BOTH classes is refused", () => {
  // The reason the function cannot be an ordered if/else chain. Either order
  // labels one of these wrong; refusing labels neither wrong.
  it("[regression] NORGES BANK … PENSION FUND GLOBAL is not DII", () => {
    const norges =
      "NORGES BANK ON ACCOUNT OF THE GOVERNMENT PENSION FUND GLOBAL";
    // Prove the conflict is real before asserting the refusal — otherwise this
    // case would pass for the boring reason that neither list matched.
    const tok = tokenizeClientName(norges);
    assert.ok(tok.includes(" PENSION "), "DII marker missing from the trap");
    assert.ok(tok.includes(" GLOBAL "), "FII marker missing from the trap");
    assert.equal(classifyInstitutionalClient(norges), "INSTITUTIONAL");
  });

  it("[regression] AMERICAN FUNDS INSURANCE SERIES … GLOBAL … is not DII", () => {
    assert.equal(
      classifyInstitutionalClient(
        "AMERICAN FUNDS INSURANCE SERIES GLOBAL SMALL CAPITALIZATION FUND",
      ),
      "INSTITUTIONAL",
    );
  });

  it("a clean single-class name is NOT refused", () => {
    // Guards the refusal from over-firing: if it did, everything would be
    // INSTITUTIONAL and the suite above would still pass.
    assert.equal(classifyInstitutionalClient("SBI MUTUAL FUND"), "DII");
    assert.equal(classifyInstitutionalClient("BLACKROCK GLOBAL FUNDS"), "FII");
  });
});

describe("MONEY-268 — the weak-marker veto", () => {
  it("[regression] an Indian form beats a weak-ONLY FII match", () => {
    // Both reached a live sector card labelled FII during this ticket's runtime
    // check against prod. That is the defect this veto exists for.
    for (const name of [
      "RAJASTHAN GLOBAL SECURITIES PVT LTD",
      "OSC GLOBAL PROCESSING PRIVATE LIMITED",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "INSTITUTIONAL", name);
    }
  });

  it("a STRONG marker is immune to the veto", () => {
    // NSE writes this name with "PVT LTD" on a Mauritius entity, which is why
    // the veto had to be scoped to weak-only matches instead of applied flat.
    assert.equal(
      classifyInstitutionalClient("CITIGROUP GLOBAL MARKETS MAURITIUS PVT LTD"),
      "FII",
    );
    assert.equal(
      classifyInstitutionalClient(
        "CITIGROUP GLOBAL MARKETS MAURITIUS PRIVATE LIMITED - ODI",
      ),
      "FII",
    );
  });

  it("the veto costs no genuine foreign fund in the captured set", () => {
    for (const name of [
      "BLACKROCK GLOBAL FUNDS",
      "PINE OAK GLOBAL FUND",
      "MANULIFE GLOBAL FUND INDIA EQUITY FUND",
      "INVESCO GLOBAL ENDEAVOUR FUND",
      "MORGAN STANLEY INVESTMENT FUNDS COUNTERPOINT GLOBAL FUND",
      "CAPITAL GROUP GLOBAL NEW PERSPECTIVE FUND (LUX)",
      "OPTIMIX WHOLESALE GLOBAL EMERGING MARKETS SHARE TRUST",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "FII", name);
    }
  });

  it("the veto never PROMOTES — a vetoed name is unknown, not DII", () => {
    assert.notEqual(
      classifyInstitutionalClient("RAJASTHAN GLOBAL SECURITIES PVT LTD"),
      "DII",
    );
  });
});

describe("MONEY-268 — retired markers stay retired", () => {
  it("CAPITAL MARKETS and TRUSTEE are recorded, with their evidence", () => {
    assert.deepEqual(Object.keys(RETIRED_MARKERS).sort(), [
      "CAPITAL MARKETS",
      "TRUSTEE",
    ]);
    for (const [marker, why] of Object.entries(RETIRED_MARKERS)) {
      assert.ok(
        why.length > 20,
        `${marker} was retired without saying why — the note is the audit trail`,
      );
    }
  });

  it("[canary] neither is in an ACTIVE marker set", () => {
    for (const marker of Object.keys(RETIRED_MARKERS)) {
      assert.ok(
        !FII_MARKERS.includes(marker),
        `${marker} is back in FII_MARKERS — re-measure before re-enabling`,
      );
      assert.ok(
        !DII_MARKERS.includes(marker),
        `${marker} is back in DII_MARKERS — re-measure before re-enabling`,
      );
    }
  });

  it("[regression] the names they used to catch are unknown, not mislabelled", () => {
    for (const name of [
      "ARIHANT CAPITAL MARKETS LIMITED",
      "TOWER RESEARCH CAPITAL MARKETS INDIA PRIVATE LIMITED",
      "CARE SUPER PTY LTD AS TRUSTEE FOR CARE SUPER",
      "UNITED SUPER PTY LTD AS TRUSTEE FOR CONSTRUCTION AND BUILDING UNIONS SUPERANNUATION FUND",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "INSTITUTIONAL", name);
    }
  });
});

describe("MONEY-268 — the markers that do work", () => {
  it("jurisdiction markers classify FII", () => {
    for (const name of [
      "ISHARES INDIA INDEX MAURITIUS COMPANY",
      "COPTHALL MAURITIUS INVESTMENT LTD",
      "MORGAN STANLEY ASIA SINGAPORE PTE",
      "GOVERNMENT OF SINGAPORE",
      "MONETARY AUTHORITY OF SINGAPORE",
      "SEGANTII INDIA MAURITIUS",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "FII", name);
    }
  });

  it("foreign legal forms classify FII", () => {
    for (const name of [
      "ABS DIRECT EQUITY FUND LLC - INDIA SERIES 1",
      "WITAN INVESTMENT TRUST PLC RE GQG PARTNERS LLC",
      "PZENA VALUE FUNDS PLC/PZENA EMERGING MARKETS VALUE FUND",
      "WASHINGTON ST INVESTMENT BOARD MANAGED BY GQG PARTNERS LLC",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "FII", name);
    }
  });

  it("domestic institution markers classify DII", () => {
    for (const name of [
      "SBI MUTUAL FUND",
      "HDFC MUTUAL FUND",
      "MAHINDRA MANULIFE MUTUAL FUND",
      "ICICI PRUDENTIAL LIFE INSURANCE COMPANY LIMITED",
      "EDELWEISS LIFE INSURANCE COMPANY LIMITED",
    ]) {
      assert.equal(classifyInstitutionalClient(name), "DII", name);
    }
  });

  it("the zero-hit markers are still wired, not merely listed", () => {
    // FPI / OFFSHORE / LIC / AMC / EPFO appear in ZERO of the 400 captured
    // names. Without a case each, an implementation that dropped them from the
    // scan would look identical to one that kept them.
    assert.equal(classifyInstitutionalClient("ACME INDIA FPI I"), "FII");
    assert.equal(classifyInstitutionalClient("ACME OFFSHORE FUND"), "FII");
    assert.equal(classifyInstitutionalClient("LIC OF INDIA"), "DII");
    assert.equal(classifyInstitutionalClient("MIRAE ASSET AMC"), "DII");
    assert.equal(classifyInstitutionalClient("EPFO"), "DII");
    // …and the substring collisions those short tokens would cause.
    assert.equal(
      classifyInstitutionalClient("PUBLIC HOLDINGS LTD"),
      "INSTITUTIONAL",
    );
    assert.equal(
      classifyInstitutionalClient("DYNAMC TRADERS"),
      "INSTITUTIONAL",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Whole-corpus invariants.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — corpus-wide behaviour", () => {
  const byClass = (): Record<InstitutionalClientClass, string[]> => {
    const out: Record<InstitutionalClientClass, string[]> = {
      FII: [],
      DII: [],
      INSTITUTIONAL: [],
    };
    for (const n of names) out[classifyInstitutionalClient(n)].push(n);
    return out;
  };

  it("the distribution is the measured one", () => {
    const d = byClass();
    // Measured 2026-08-19 against this exact fixture. These are pinned rather
    // than bounded because a shift means the marker sets changed, and the
    // person changing them should have to look at what moved.
    assert.equal(d.FII.length, 45, "FII count moved");
    assert.equal(d.DII.length, 29, "DII count moved");
    assert.equal(d.INSTITUTIONAL.length, 326, "INSTITUTIONAL count moved");
  });

  it("the classifier UNDER-claims: unknown is the large majority", () => {
    // The design property, stated as a property rather than a count. An
    // allowlist that recognised most names would be pattern-matching, not
    // allowlisting.
    const d = byClass();
    assert.ok(
      d.INSTITUTIONAL.length > names.length * 0.6,
      `only ${d.INSTITUTIONAL.length}/${names.length} unrecognised — the marker ` +
        "sets have grown loose enough to be guessing",
    );
  });

  it("every classified name can be traced to a marker in the exported sets", () => {
    // No hidden rule: if a name is FII/DII, the reason must be visible in the
    // constants this module exports. Otherwise the audit trail is a lie.
    for (const n of names) {
      const cls = classifyInstitutionalClient(n);
      if (cls === "INSTITUTIONAL") continue;
      const tok = tokenizeClientName(n);
      const set = cls === "FII" ? FII_MARKERS : DII_MARKERS;
      assert.ok(
        set.some((m) => tok.includes(` ${m} `)),
        `${n} → ${cls} with no marker from the exported ${cls} set`,
      );
    }
  });

  it("is total and deterministic over the whole corpus", () => {
    for (const n of names) {
      const a = classifyInstitutionalClient(n);
      const b = classifyInstitutionalClient(n);
      assert.equal(a, b, `${n} classified differently on a repeat call`);
      assert.ok(["FII", "DII", "INSTITUTIONAL"].includes(a), `${n} → ${a}`);
    }
  });

  it("is case- and whitespace-insensitive over the whole corpus", () => {
    for (const n of names) {
      assert.equal(
        classifyInstitutionalClient(n.toLowerCase()),
        classifyInstitutionalClient(n),
        `${n}: lowercasing changed the answer`,
      );
      assert.equal(
        classifyInstitutionalClient(`  ${n.replace(/ /g, "  ")}  `),
        classifyInstitutionalClient(n),
        `${n}: extra whitespace changed the answer`,
      );
    }
  });

  it("marker sets are disjoint, non-empty and internally consistent", () => {
    assert.deepEqual(
      [...STRONG_FII_MARKERS, ...WEAK_FII_MARKERS],
      [...FII_MARKERS],
      "FII_MARKERS must be exactly strong ∪ weak, or the audit view lies",
    );
    for (const m of FII_MARKERS) {
      assert.ok(!DII_MARKERS.includes(m), `${m} is in both marker sets`);
    }
    for (const set of [FII_MARKERS, DII_MARKERS, INDIAN_FORM_TOKENS]) {
      assert.ok(set.length > 0);
      for (const m of set) {
        // A marker with a lowercase letter or a stray separator can never match
        // a tokenised name, so it would be dead config that reads as live.
        assert.match(m, /^[A-Z0-9]+( [A-Z0-9]+)*$/, `unmatchable marker: ${m}`);
      }
    }
  });
});

describe("MONEY-268 — the chip label", () => {
  it("INSTITUTIONAL renders as a word, not an acronym", () => {
    assert.equal(institutionalClassLabel("INSTITUTIONAL"), "Institutional");
    assert.equal(institutionalClassLabel("FII"), "FII");
    assert.equal(institutionalClassLabel("DII"), "DII");
  });
});
