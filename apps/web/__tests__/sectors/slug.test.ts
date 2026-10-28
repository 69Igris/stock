/**
 * Sector slug canonicalisation (MONEY-1092).
 *
 * The contract under test is "NORMALIZE on write, RESOLVE BY LOOKUP on
 * read" — so the cases that matter are the ones where a reverse transform
 * would have been wrong. The old route did `slug.replace(/-/g, " ")`, which
 * silently corrupts any sector containing a hyphen or non-alphanumerics.
 *
 * Source: apps/web/lib/sectors/slug.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSectorSlug,
  resolveSectorSlug,
  isSameSector,
} from "@/lib/sectors/slug";

/** The 13 canonical NSE sectors, plus the sentinel and the passthrough
 *  buckets that exist in production today. */
const LIVE_SECTORS = [
  "Information Technology",
  "Financial Services",
  // MONEY-1093 — the 13th canonical sector. Its absence here is why the new
  // slug's round-trip went untested, and "Realty" (its alias) must NOT appear:
  // an alias in the canonical set would give one asset class two buckets.
  "Real Estate",
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
  // Non-canonical values observed in the live heatmap.
  "Not Categorised",
  "Other",
  "Agriculture",
  "Media & Entertainment",
];

describe("normalizeSectorSlug", () => {
  it("lowercases and hyphenates whitespace", () => {
    assert.equal(
      normalizeSectorSlug("Information Technology"),
      "information-technology"
    );
  });

  it("trims and collapses whitespace runs", () => {
    assert.equal(
      normalizeSectorSlug("  Financial   Services  "),
      "financial-services"
    );
  });

  it("is idempotent — normalising a slug returns the slug", () => {
    for (const name of LIVE_SECTORS) {
      const once = normalizeSectorSlug(name);
      assert.equal(
        normalizeSectorSlug(once),
        once,
        `${name} is not idempotent`
      );
    }
  });

  it("leaves ampersands and slashes intact for the URL encoder to handle", () => {
    // URLSearchParams percent-encodes these in a query VALUE; pre-mangling
    // them here would be a second, lossy transform.
    assert.equal(
      normalizeSectorSlug("Media & Entertainment"),
      "media-&-entertainment"
    );
    assert.equal(normalizeSectorSlug("N/A"), "n/a");
  });
});

describe("resolveSectorSlug — round trip", () => {
  it("round-trips every live sector through slug and back", () => {
    for (const name of LIVE_SECTORS) {
      const slug = normalizeSectorSlug(name);
      assert.equal(
        resolveSectorSlug(slug, LIVE_SECTORS),
        name,
        `${name} did not survive the round trip`
      );
    }
  });

  it("round-trips through real URL encoding, not just the raw slug", () => {
    // This is the path an actual browser takes: build a query string, parse
    // it back. Any scheme that breaks on "&" or "/" fails here.
    for (const name of LIVE_SECTORS) {
      const params = new URLSearchParams({ sector: normalizeSectorSlug(name) });
      const parsed = new URLSearchParams(params.toString()).get("sector");
      assert.equal(
        resolveSectorSlug(parsed, LIVE_SECTORS),
        name,
        `${name} did not survive URL encoding`
      );
    }
  });

  it("survives a hyphen inside the sector name — the old reverse transform did not", () => {
    // Regression pin. `slug.replace(/-/g, " ")` turned this into
    // "consumer non durables", which matches no sector at all.
    const sectors = [...LIVE_SECTORS, "Consumer Non-Durables"];
    const slug = normalizeSectorSlug("Consumer Non-Durables");
    assert.equal(resolveSectorSlug(slug, sectors), "Consumer Non-Durables");
    assert.notEqual(slug.replace(/-/g, " "), "Consumer Non-Durables");
  });

  it("matches case-insensitively so a hand-typed URL still works", () => {
    assert.equal(
      resolveSectorSlug("FINANCIAL-SERVICES", LIVE_SECTORS),
      "Financial Services"
    );
  });

  it("accepts a display name in the slot, not only a slug", () => {
    assert.equal(
      resolveSectorSlug("Financial Services", LIVE_SECTORS),
      "Financial Services"
    );
  });
});

describe("resolveSectorSlug — non-matches", () => {
  it("returns null for an unknown sector rather than throwing", () => {
    // A stale bookmark must degrade to "no selection", not an error page.
    assert.equal(resolveSectorSlug("crypto", LIVE_SECTORS), null);
  });

  it("returns null for null, undefined, empty and whitespace-only input", () => {
    assert.equal(resolveSectorSlug(null, LIVE_SECTORS), null);
    assert.equal(resolveSectorSlug(undefined, LIVE_SECTORS), null);
    assert.equal(resolveSectorSlug("", LIVE_SECTORS), null);
    assert.equal(resolveSectorSlug("   ", LIVE_SECTORS), null);
  });

  it("returns null when there are no sectors to match against", () => {
    assert.equal(resolveSectorSlug("financial-services", []), null);
  });
});

describe("isSameSector", () => {
  it("equates a slug with its display name", () => {
    assert.equal(
      isSameSector("financial-services", "Financial Services"),
      true
    );
  });

  it("does not equate distinct sectors", () => {
    assert.equal(isSameSector("Energy", "Utilities"), false);
  });

  it("treats a hyphen and a space as the same separator", () => {
    // Deliberate: users hand-editing the URL should not be punished for it.
    assert.equal(
      isSameSector("media-&-entertainment", "Media & Entertainment"),
      true
    );
  });
});
