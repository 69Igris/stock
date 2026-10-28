/**
 * Sector heatmap bucket labelling (MONEY-1092).
 *
 * "N/A" is the SECTOR_SKIPPED sentinel the enrichment pipeline writes when
 * Yahoo can't resolve a symbol — deliberately non-null so dead symbols are
 * never re-fetched. Four other surfaces (lib/sectors/aggregate.ts,
 * discover.service, discover-market.service, screener.service) already
 * display it as "Not Categorised". The heatmap rendered the raw sentinel,
 * so the same stocks carried two different labels depending which page you
 * were on.
 *
 * The other half of the contract matters just as much: NON-canonical
 * passthrough buckets ("Other", "Agriculture", …) must be left ALONE.
 * Folding them in here would hide a real data-quality problem AND silently
 * change every m-cap weight in the ranked table.
 *
 * Source: apps/web/lib/sectors/buckets.ts (consumed by lib/actions/sector-heatmap.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBucketName,
  UNCATEGORISED_SECTOR,
} from "@/lib/sectors/buckets";

describe("normalizeBucketName", () => {
  it("remaps the N/A sentinel to the label every other surface uses", () => {
    assert.equal(normalizeBucketName("N/A"), UNCATEGORISED_SECTOR);
    assert.equal(UNCATEGORISED_SECTOR, "Not Categorised");
  });

  it("leaves canonical NSE sectors untouched", () => {
    for (const name of [
      "Information Technology",
      "Financial Services",
      "Healthcare",
      "Energy",
      "Consumer Discretionary",
      "Industrials",
      "Commodities",
      "FMCG",
      "Telecommunication",
      "Utilities",
      "Services",
      "Diversified",
      // MONEY-1093 — 13th canonical sector. Its absence here is why the new
      // slug's round-trip and its heatmap bucket went untested.
      "Real Estate",
    ]) {
      assert.equal(normalizeBucketName(name), name);
    }
  });

  it("leaves NON-canonical passthrough buckets visible and unchanged", () => {
    // Deliberate. These are a data problem, not a display problem —
    // collapsing them here would conceal it and shift the ranked table's
    // m-cap denominator at the same time.
    for (const name of ["Other", "Agriculture", "Media & Entertainment"]) {
      assert.equal(normalizeBucketName(name), name);
    }
  });

  it("is case-sensitive about the sentinel — only the exact token remaps", () => {
    // "n/a" is not a value the enrichment pipeline writes; treating it as
    // the sentinel would silently swallow a genuinely odd sector string.
    assert.equal(normalizeBucketName("n/a"), "n/a");
    assert.equal(normalizeBucketName("NA"), "NA");
  });

  it("is idempotent", () => {
    assert.equal(
      normalizeBucketName(normalizeBucketName("N/A")),
      UNCATEGORISED_SECTOR
    );
  });
});
