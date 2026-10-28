/**
 * Feature Guides Data Tests
 *
 * Tests for the feature guides data module: guide structure,
 * link validity, content quality, and completeness.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  featureGuides,
  type FeatureGuide,
} from "../../app/help/lib/feature-guides-data";

const APP_DIR = join(__dirname, "..", "..", "app");

/**
 * Every routable path under `app/`, as "/segment/segment".
 *
 * A directory is a route when it holds a `page.tsx`. Route GROUPS — `(auth)`,
 * `(marketing)` — are transparent in the URL, so their children are collected
 * under the parent path rather than under the group name. Dynamic segments
 * (`[symbol]`) are skipped: a guide should link to a concrete page, never to a
 * bare parameterised route.
 */
function discoverAppRoutes(dir = APP_DIR, prefix = ""): Set<string> {
  const found = new Set<string>();
  if (!existsSync(dir)) return found;
  if (prefix !== "" && existsSync(join(dir, "page.tsx"))) found.add(prefix);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === "api" || name.startsWith("_") || name.startsWith("["))
      continue;
    // A (group) contributes no URL segment of its own.
    const nextPrefix = /^\(.+\)$/.test(name) ? prefix : `${prefix}/${name}`;
    for (const r of discoverAppRoutes(join(dir, name), nextPrefix))
      found.add(r);
  }
  return found;
}

describe("Feature Guides Data", () => {
  describe("structure", () => {
    it("should export an array of guides", () => {
      assert.ok(Array.isArray(featureGuides));
      assert.ok(featureGuides.length > 0);
    });

    it("should have exactly 11 guides", () => {
      assert.strictEqual(featureGuides.length, 11);
    });

    it("should have all required fields on every guide", () => {
      for (const guide of featureGuides) {
        assert.ok(guide.title, "Guide missing title");
        assert.ok(
          guide.description,
          `Guide "${guide.title}" missing description`
        );
        assert.ok(guide.href, `Guide "${guide.title}" missing href`);
        assert.ok(guide.icon, `Guide "${guide.title}" missing icon`);
      }
    });
  });

  describe("uniqueness", () => {
    it("should have unique titles", () => {
      const titles = featureGuides.map((g: FeatureGuide) => g.title);
      const unique = new Set(titles);
      assert.strictEqual(
        unique.size,
        titles.length,
        "Duplicate guide titles found"
      );
    });
  });

  describe("links", () => {
    it("all hrefs should start with /", () => {
      for (const guide of featureGuides) {
        assert.ok(
          guide.href.startsWith("/"),
          `Guide "${guide.title}" href "${guide.href}" doesn't start with /`
        );
      }
    });

    it("hrefs should reference valid app routes", () => {
      // MONEY-1254 — derived from the filesystem, not a hand-kept allowlist.
      //
      // The old list was hardcoded, and stale: it had `/discover` but not
      // `/discover/screener`, `/discover/markets`, `/risk`, `/tax` or
      // `/documents`. That made it fail CORRECT links while passing the bug
      // this ticket fixes — the "Stock Screening" card pointed at `/discover`,
      // a real route but the wrong page, and an allowlist can only ever catch
      // "route does not exist", never "real route, wrong page".
      //
      // Walking `app/` means the check tracks the routes that actually ship.
      // It still cannot judge whether a link points at the RIGHT page; that is
      // what the per-guide assertions below are for.
      const routes = discoverAppRoutes();
      assert.ok(
        routes.size > 10,
        `route discovery found only ${routes.size} routes — the walk is probably broken`
      );
      for (const guide of featureGuides) {
        const baseHref = guide.href.split("?")[0];
        assert.ok(
          routes.has(baseHref),
          `Guide "${guide.title}" href "${guide.href}" is not a real route (no page.tsx under app${baseHref})`
        );
      }
    });
  });

  describe("content quality", () => {
    it("titles should be concise (under 30 chars)", () => {
      for (const guide of featureGuides) {
        assert.ok(
          guide.title.length <= 30,
          `Guide title too long: "${guide.title}" (${guide.title.length} chars)`
        );
      }
    });

    it("descriptions should be meaningful (50+ chars)", () => {
      for (const guide of featureGuides) {
        assert.ok(
          guide.description.length >= 50,
          `Guide "${guide.title}" description too short: ${guide.description.length} chars`
        );
      }
    });

    it("descriptions should not be too long (under 300 chars)", () => {
      for (const guide of featureGuides) {
        assert.ok(
          guide.description.length <= 300,
          `Guide "${guide.title}" description too long: ${guide.description.length} chars`
        );
      }
    });
  });

  describe("key features covered", () => {
    // "Paper Trading" guide was removed 2026-05-28 per product decision.
    const requiredFeatures = [
      "StockSage Chat",
      "Holdings",
      "Positions",
      "Tradebook",
      "FIRE",
      "Mutual Funds",
    ];

    for (const feature of requiredFeatures) {
      it(`should include a guide for: ${feature}`, () => {
        const found = featureGuides.some((g: FeatureGuide) =>
          g.title.toLowerCase().includes(feature.toLowerCase())
        );
        assert.ok(found, `Missing feature guide for: ${feature}`);
      });
    }
  });

  describe("icon values", () => {
    it("all icons should be non-empty strings", () => {
      for (const guide of featureGuides) {
        assert.ok(
          typeof guide.icon === "string" && guide.icon.length > 0,
          `Guide "${guide.title}" has invalid icon`
        );
      }
    });

    it("icons should be PascalCase (lucide convention)", () => {
      const pascalRegex = /^[A-Z][a-zA-Z0-9]*$/;
      for (const guide of featureGuides) {
        assert.ok(
          pascalRegex.test(guide.icon),
          `Guide "${guide.title}" icon "${guide.icon}" is not PascalCase`
        );
      }
    });
  });
});
