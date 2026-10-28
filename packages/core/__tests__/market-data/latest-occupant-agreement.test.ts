/**
 * The two `latestOccupantOf` copies, pinned — MONEY-1617 review.
 *
 * `packages/lake` must not import core and core must not depend on lake, so the
 * rule "which window of a recycled ticker is its current occupant" exists
 * twice: in `databento-symbology.ts` (the candle writer's clip) and in
 * `packages/lake/src/us-sink-logic.ts` (the lake gate). If they drift, the
 * writer files a shared session under one listing and the gate quarantines it
 * as belonging to another. Only core's test tsconfig can see both packages, so
 * the pin lives here — the `numeric()` / `istDateKey` arrangement.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  latestOccupantOf as coreOccupant,
  type OccupancyWindowLike,
} from "../../src/market-data/databento/databento-symbology";
import { latestOccupantOf as lakeOccupant } from "../../../lake/src/us-sink-logic";

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const w = (
  listingId: string,
  start: string | null,
  end: string | Date | null,
): OccupancyWindowLike => ({
  listingId,
  listingStartDate: start ? d(start) : null,
  listingEndDate: end === null ? null : end instanceof Date ? end : d(end),
});

const BARNES = w("B:NYSE:1985-02-04", "1985-02-04", "2025-07-02");
const BARRICK = w("B:NYSE:1985-06-24", "1985-06-24", "2026-09-22");

/** Every shape either copy has a rule for; `expect` is the answer both must give. */
const CASES: Array<{
  name: string;
  windows: OccupancyWindowLike[];
  expect: string | null;
}> = [
  { name: "empty", windows: [], expect: null },
  { name: "single window", windows: [BARRICK], expect: null },
  {
    name: "Barnes/Barrick: the later end is the occupant",
    windows: [BARNES, BARRICK],
    expect: BARRICK.listingId,
  },
  {
    name: "order does not decide",
    windows: [BARRICK, BARNES],
    expect: BARRICK.listingId,
  },
  {
    name: "tie: two rows end together (WNS)",
    windows: [
      w("WNS:NYSE:2002-07-31", "2002-07-31", "2025-10-16"),
      w("WNS:NYSE:2024-03-28", "2024-03-28", "2025-10-16"),
    ],
    expect: null,
  },
  {
    name: "open end beats any date",
    windows: [BARRICK, w("B:NYSE:2025-07-03", "2025-07-03", null)],
    expect: "B:NYSE:2025-07-03",
  },
  {
    name: "two open ends tie",
    windows: [
      w("X:NYSE:2001-01-02", "2001-01-02", null),
      w("X:NYSE:2020-01-02", "2020-01-02", null),
    ],
    expect: null,
  },
  {
    name: "Invalid Date end is null, not skipped",
    windows: [BARRICK, w("B:NYSE:1990-01-02", "1990-01-02", new Date("nope"))],
    expect: null,
  },
  {
    name: "tie below a unique latest is still an answer",
    windows: [BARNES, { ...BARNES, listingId: "B:NYSE:1999-01-04" }, BARRICK],
    expect: BARRICK.listingId,
  },
  {
    name: "multi-venue: the occupant may sit on another exchange",
    windows: [
      BARNES,
      w("B:NASDAQ:2025-07-03", "2025-07-03", "2026-09-22"),
      w("B:BATS:2010-01-04", "2010-01-04", "2012-01-03"),
    ],
    expect: "B:NASDAQ:2025-07-03",
  },
];

describe("latestOccupantOf agrees across the package boundary", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const core = coreOccupant(c.windows)?.listingId ?? null;
      const lake = lakeOccupant(c.windows)?.listingId ?? null;
      assert.equal(core, lake, `core and lake disagree on "${c.name}"`);
      assert.equal(core, c.expect, `"${c.name}"`);
    });
  }
});
