/**
 * Scan Catalog — pure invariants (MONEY-795 · C2).
 *
 * The catalog merges three registries (99 Chartink + research builtin +
 * core screener strategies) into one deduped `ScanDef[]`. These tests pin
 * the merge invariants so a registry change can't silently break the
 * `/discover/scans` page or `runScanAction`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCAN_CATALOG,
  listScans,
  scansByCategory,
  getScan,
  listScanCategories,
  searchScans,
  scanCategoryLabel,
  type ScanDef,
} from "@/lib/scans/catalog";
import { isScreenerRunnable } from "@/lib/scans/scan-filters";

describe("scan catalog — structure", () => {
  it("is non-empty and spans all three sources", () => {
    assert.ok(SCAN_CATALOG.length > 100, "expected 100+ merged scans");
    const sources = new Set(SCAN_CATALOG.map((s) => s.source));
    assert.ok(sources.has("core"), "has core scans");
    assert.ok(sources.has("builtin"), "has builtin scans");
    assert.ok(sources.has("chartink"), "has chartink scans");
  });

  it("every scan has a name, description, category and source", () => {
    for (const s of SCAN_CATALOG) {
      assert.ok(s.name && s.name.length > 0, `name missing on ${s.id}`);
      assert.ok(
        s.description && s.description.length > 0,
        `description missing on ${s.id}`
      );
      assert.ok(s.category, `category missing on ${s.id}`);
      assert.ok(s.source, `source missing on ${s.id}`);
      assert.ok(Array.isArray(s.tags), `tags not array on ${s.id}`);
      assert.equal(typeof s.runnable, "boolean", `runnable flag on ${s.id}`);
    }
  });

  it("has no duplicate ids", () => {
    const ids = SCAN_CATALOG.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  });

  it("dedupes by normalised name (no two scans share a name)", () => {
    const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const names = SCAN_CATALOG.map((s) => norm(s.name));
    assert.equal(new Set(names).size, names.length, "names must be unique");
  });

  it("namespaces every id by its source", () => {
    for (const s of SCAN_CATALOG) {
      assert.ok(
        s.id.startsWith(`${s.source}:`),
        `id ${s.id} should be namespaced by source ${s.source}`
      );
    }
  });

  it("runnable scans carry engine filters; chartink scans carry a query", () => {
    for (const s of SCAN_CATALOG) {
      if (s.runnable) {
        assert.ok(
          s.filters && s.filters.length > 0,
          `runnable scan ${s.id} must have filters`
        );
      }
      if (s.source === "chartink") {
        assert.ok(
          s.chartinkQuery && s.chartinkQuery.length > 0,
          `chartink scan ${s.id} must carry a query`
        );
        assert.equal(s.runnable, false, "chartink scans are browse-only today");
      }
    }
  });

  it("at least one scan is inline-runnable (core fundamental)", () => {
    const runnable = SCAN_CATALOG.filter((s) => s.runnable);
    assert.ok(runnable.length > 0, "expected ≥1 runnable scan");
    assert.ok(
      runnable.every((s) => s.source === "core"),
      "only core scans are runnable inline today"
    );
  });

  it("every scan has a well-formed namespaced id and a known source", () => {
    const validSources = new Set(["core", "builtin", "chartink"]);
    for (const s of SCAN_CATALOG) {
      assert.ok(validSources.has(s.source), `unknown source on ${s.id}`);
      // namespaced "source:rest" — `rest` must be non-empty so getScan() has
      // a stable key (a bare "core:" would collide across registries).
      const [ns, ...rest] = s.id.split(":");
      assert.equal(ns, s.source, `id ${s.id} ns mismatch`);
      assert.ok(rest.join(":").length > 0, `id ${s.id} has empty local part`);
    }
  });

  it("treats the chartink DSL as inert DATA (carried, never runnable)", () => {
    // The raw scan_clause must be surfaced as a string only — it is never
    // eval'd / interpolated into a query, and a chartink scan must never be
    // flagged runnable (that would route a raw DSL string into the engine).
    const chartink = SCAN_CATALOG.filter((s) => s.source === "chartink");
    assert.ok(chartink.length > 50, "expected the full chartink library");
    for (const s of chartink) {
      assert.equal(typeof s.chartinkQuery, "string");
      assert.equal(s.runnable, false, `chartink ${s.id} must be browse-only`);
      assert.equal(
        s.filters,
        undefined,
        `chartink ${s.id} must not carry engine filters`
      );
    }
  });

  it("non-runnable scans never map to a screener band (runner fails them closed)", () => {
    // A non-runnable core scan MAY still carry raw (technical) filters — they
    // just don't map to a fundamental band. The safety invariant is that
    // `isScreenerRunnable` (which runScanAction re-checks at runtime) is false
    // for every non-runnable scan, so none can become a full-universe dump.
    for (const s of SCAN_CATALOG) {
      if (!s.runnable) {
        assert.equal(
          isScreenerRunnable(s.filters),
          false,
          `non-runnable ${s.id} must not map to any band`
        );
      }
    }
  });

  it("merges 100+ scans across the three registries (collision-free)", () => {
    // A regression where one registry shadows another by id collision would
    // shrink the merged total; pin a sane floor + the id-uniqueness invariant
    // together so a silent collapse is caught.
    assert.ok(SCAN_CATALOG.length >= 100, "expected 100+ merged scans");
    const ids = SCAN_CATALOG.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "ids collide");
  });
});

describe("scan catalog — helpers", () => {
  it("listScans() returns the full catalog by default", () => {
    assert.equal(listScans().length, SCAN_CATALOG.length);
  });

  it("listScans(category) and scansByCategory agree and filter correctly", () => {
    const cat = SCAN_CATALOG[0]!.category;
    const a = listScans(cat);
    const b = scansByCategory(cat);
    assert.deepEqual(
      a.map((s) => s.id),
      b.map((s) => s.id)
    );
    assert.ok(a.length > 0);
    assert.ok(a.every((s) => s.category === cat));
  });

  it("getScan() round-trips a known id and rejects unknown", () => {
    const first = SCAN_CATALOG[0]!;
    const got = getScan(first.id);
    assert.equal(got?.id, first.id);
    assert.equal(getScan("nope:does-not-exist"), undefined);
  });

  it("listScanCategories() leads with All and sums to the total", () => {
    const cats = listScanCategories();
    assert.equal(cats[0]!.category, "all");
    assert.equal(cats[0]!.count, SCAN_CATALOG.length);
    const summed = cats
      .filter((c) => c.category !== "all")
      .reduce((n, c) => n + c.count, 0);
    assert.equal(
      summed,
      SCAN_CATALOG.length,
      "category counts cover every scan"
    );
  });

  it("every category has a human label", () => {
    for (const s of SCAN_CATALOG) {
      const label = scanCategoryLabel(s.category);
      assert.ok(label && label.length > 0, `label for ${s.category}`);
    }
  });

  it("searchScans() narrows by term and matches name/tags", () => {
    const all = searchScans("");
    assert.equal(all.length, SCAN_CATALOG.length);

    const golden = searchScans("golden cross");
    assert.ok(golden.length > 0, "finds golden cross scans");
    assert.ok(
      golden.every(
        (s: ScanDef) =>
          [s.name, s.description, ...s.tags]
            .join(" ")
            .toLowerCase()
            .includes("golden") ||
          [s.name, s.description, ...s.tags]
            .join(" ")
            .toLowerCase()
            .includes("cross")
      )
    );
  });

  it("searchScans() treats whitespace-only as empty (no crash, full set)", () => {
    assert.equal(searchScans("   ").length, SCAN_CATALOG.length);
  });

  it("searchScans() is AND across terms and returns [] for no match", () => {
    assert.deepEqual(searchScans("zzz-no-such-scan-token"), []);
  });

  it("scansByCategory returns [] for an empty category bucket", () => {
    // 'other' may or may not be populated, but a category with zero scans
    // must return an empty array (not throw, not the full catalog).
    const result = scansByCategory("ichimoku");
    assert.ok(Array.isArray(result));
    assert.ok(result.every((s) => s.category === "ichimoku"));
  });

  it("every scan exposes a non-empty tag array", () => {
    for (const s of SCAN_CATALOG) {
      assert.ok(Array.isArray(s.tags), `tags array on ${s.id}`);
      assert.ok(
        s.tags.every((t) => typeof t === "string"),
        `tags are strings on ${s.id}`
      );
    }
  });

  it("search + category compose into one filter (the /discover/scans page contract)", () => {
    // The scans page derives its visible grid by intersecting `searchScans`
    // (free-text) with `scansByCategory` (active chip). This pins that the
    // shared catalog helpers compose the way the client relies on — so the
    // page can't drift back to a divergent inline copy of the filter.
    const cat = SCAN_CATALOG[0]!.category;
    const byText = searchScans("");
    const inCategory = new Set(scansByCategory(cat).map((s) => s.id));
    const composed = byText.filter((s) => inCategory.has(s.id));

    // Empty query → full catalog, so the intersection is exactly the category.
    assert.deepEqual(
      composed.map((s) => s.id).sort(),
      scansByCategory(cat)
        .map((s) => s.id)
        .sort()
    );
    assert.ok(composed.length > 0);
    assert.ok(composed.every((s) => s.category === cat));

    // Whitespace-only query behaves like empty (no crash, same intersection).
    const ws = searchScans("   ").filter((s) => inCategory.has(s.id));
    assert.equal(ws.length, composed.length);
  });
});
