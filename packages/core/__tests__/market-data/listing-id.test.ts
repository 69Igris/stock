/**
 * `buildListingId` — THE listing id, and every India lake writer agreeing with
 * it on REAL prod ids. MONEY-1522.
 *
 * Measured on prod 2026-09-22: `lake_silver.listing` held 23,907 India ids
 * spelled `{symbol}:{exchange}:unknown` and `price_bar_d1` held 16,898 spelled
 * `{symbol}:{exchange}`, and the two sets intersected in NOTHING — every
 * identity-to-bars join in gold returned zero while every writer reported
 * success. The fix is one builder and one arity; this file is the proof that
 * the writers now land on the ids the identity table actually holds.
 *
 * ## WHY A CHECKED-IN FIXTURE, AND WHY IT LIVES ON THIS SIDE
 *
 * A unit test cannot query prod, and a hand-written id would only prove the
 * test agrees with itself — which is exactly how the defect shipped: each
 * writer's own tests passed against its own spelling. So the IDENTITY side is
 * real `listing` ids copied read-only from prod (what `identity-sync` wrote),
 * the BAR side is real `price_bar_d1` rows pushed through the REAL mapper with
 * the REAL builder, and the expected join is PROD's own answer, computed in SQL
 * when the fixture was taken (`fixtures/lake/india-listing-ids.json`,
 * `_provenance`).
 *
 * It sits in core because only core's test tsconfig (`rootDir: "../.."`) can
 * see both packages — `packages/lake` cannot import core, which is why its
 * mappers take the builder as an argument. Same arrangement as the `numeric()`
 * and `istDateKey` pins.
 *
 * ## THE GAP IS EXPECTED, AND THE TEST SAYS WHICH GAP
 *
 * 23 of the 32 sampled bars join (11,553 of 17,699 bar ids on prod, 65.3%).
 * India's `listing` is CURRENT-ONLY — built from today's `InstrumentMapping` —
 * so a delisted company has bars and no identity row, and a renamed one has
 * bars under the old symbol and identity under the new (ZOMATO -> ETERNAL, same
 * ISIN). Neither is this defect. The defect has a distinct fingerprint: an
 * identity row for the SAME symbol and venue, spelled differently. The second
 * case below refuses exactly that.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildListingId } from "../../src/market-data/tiingo/tiingo-logic";
import {
  toDeliveryDailyRow,
  toIndiaPriceBarRow,
  type IndiaCashBar,
  type RowProvenance,
} from "../../../lake/src/india-sink-logic";
import {
  toCorpActionSilverRow,
  type MongoCorporateActionRow,
} from "../../../lake/src/corp-action-logic";

interface FixtureBar extends Omit<IndiaCashBar, "series"> {
  firstBar: string;
  /** PROD's answer, in SQL, when the fixture was taken. */
  joinsIdentity: boolean;
  gap?: string;
}

interface Fixture {
  bars: FixtureBar[];
  identity: string[];
  corporateActions: (Omit<
    MongoCorporateActionRow,
    "exDate" | "recordDate" | "createdAt" | "updatedAt"
  > & {
    exDate: string;
    recordDate: string | null;
    createdAt: string;
    updatedAt: string;
  })[];
}

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "fixtures",
      "lake",
      "india-listing-ids.json",
    ),
    "utf8",
  ),
) as Fixture;

const IDENTITY = new Set(FIXTURE.identity);

const PROV: RowProvenance = {
  sourceObjectUri: "gs://stockbook-content-prod/feeds/NSE/bhavcopy/x.zip",
  sourceRecordKey: "nse-cm-udiff-bhavcopy:2026-09-22",
  pipelineRunId: "lake-replay-in-test",
  observedAtMs: Date.UTC(2026, 8, 22),
  ingestedAtMs: Date.UTC(2026, 8, 23),
};

/** Each bar through the mapper the replay runs, with the builder it passes. */
function barId(b: FixtureBar): string {
  return toIndiaPriceBarRow(
    { ...b, series: null },
    PROV,
    "BHAVCOPY_HIST",
    buildListingId,
  ).listing_id;
}

describe("buildListingId", () => {
  it("renders a missing listing start as `unknown` — India's three-part form", () => {
    assert.equal(
      buildListingId("RELIANCE", "NSE", null),
      "RELIANCE:NSE:unknown",
    );
    assert.equal(
      buildListingId("DOW", "NYSE", "2019-03-20"),
      "DOW:NYSE:2019-03-20",
    );
  });

  it("refuses a blank half rather than merging every such row onto one id", () => {
    // The guard the deleted `indiaListingId` carried, now covering every
    // writer. `:NSE:unknown` is a perfectly well-formed id for NOTHING.
    for (const [s, e] of [
      ["", "NSE"],
      ["  ", "NSE"],
      ["RELIANCE", ""],
      ["RELIANCE", " \t"],
    ] as const) {
      assert.throws(() => buildListingId(s, e, null), /empty half/);
    }
  });
});

describe("the India writers land on the ids silver.listing holds (real prod sample)", () => {
  it("joins exactly the bars prod says have an identity row", () => {
    const joined = FIXTURE.bars.filter((b) => IDENTITY.has(barId(b)));
    // NOT merely non-empty: the set is pinned to prod's own SQL answer, so a
    // spelling that matched SOME ids by accident would still fail.
    assert.deepEqual(
      joined.map((b) => `${b.symbol}:${b.exchange}`).sort(),
      FIXTURE.bars
        .filter((b) => b.joinsIdentity)
        .map((b) => `${b.symbol}:${b.exchange}`)
        .sort(),
    );
    assert.equal(joined.length, 23, "23 of the 32 sampled bars join");
  });

  it("every bar that does NOT join is the expected gap, never a second spelling", () => {
    // The defect's fingerprint is an identity row for the SAME symbol and
    // venue that the bar's id misses. A delisted or renamed listing has no
    // such row at all — that is India's current-only identity, not this bug.
    const misses = FIXTURE.bars.filter((b) => !IDENTITY.has(barId(b)));
    assert.equal(misses.length, 9);
    for (const b of misses) {
      const sameListing = FIXTURE.identity.filter((id) =>
        id.startsWith(`${b.symbol}:${b.exchange}:`),
      );
      assert.deepEqual(
        sameListing,
        [],
        `${b.symbol}:${b.exchange} has identity row(s) ${sameListing.join(", ")} ` +
          `that its bar id ${barId(b)} misses — a SPELLING mismatch, not a gap`,
      );
      assert.ok(
        b.gap,
        `${b.symbol}:${b.exchange} misses with no recorded reason`,
      );
    }
  });

  it("gives delivery the bar's id for the same listing", () => {
    for (const b of FIXTURE.bars) {
      const delivery = toDeliveryDailyRow(
        {
          symbol: b.symbol,
          exchange: b.exchange,
          isin: null,
          series: "EQ",
          sessionDate: b.sessionDate,
          tradedQty: b.volume,
          deliverableQty: null,
          deliveryPct: null,
        },
        PROV,
        "BHAVCOPY_HIST",
        buildListingId,
      );
      assert.equal(delivery.listing_id, barId(b), `${b.symbol}:${b.exchange}`);
    }
  });

  it("maps real corporate actions onto ids BOTH the bars and identity hold", () => {
    // Five prod Mongo documents, verbatim — including the shape of `details`,
    // which is a STRING on exchange rows and an object on DERIVED ones.
    const bars = new Set(FIXTURE.bars.map(barId));
    for (const a of FIXTURE.corporateActions) {
      const mapped = toCorpActionSilverRow(
        {
          ...a,
          exDate: new Date(a.exDate),
          recordDate: a.recordDate === null ? null : new Date(a.recordDate),
          createdAt: new Date(a.createdAt),
          updatedAt: new Date(a.updatedAt),
        },
        buildListingId,
      );
      assert.ok(mapped.ok, `${a.symbol}:${a.exchange} did not map`);
      assert.ok(
        bars.has(mapped.row.listing_id),
        `${mapped.row.listing_id} is not a bar id`,
      );
      assert.ok(
        IDENTITY.has(mapped.row.listing_id),
        `${mapped.row.listing_id} is not an identity id`,
      );
    }
  });

  it("gives every India id the US arity — three segments", () => {
    // The founder's reason for three segments: a reader splitting on `:` must
    // not have to know which market a row came from.
    for (const id of FIXTURE.bars.map(barId)) {
      assert.equal(id.split(":").length, 3, id);
    }
  });
});
