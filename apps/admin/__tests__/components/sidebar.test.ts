/**
 * Sidebar Navigation Tests - Admin App
 *
 * Exercises the REAL sidebar nav metadata + active-route logic from
 * apps/admin/components/sidebar-nav.ts (`navItems`, `isNavItemActive`,
 * `findActiveNavItem`), which sidebar.tsx imports and renders. No inline copy.
 *
 * Source: apps/admin/components/sidebar.tsx, apps/admin/components/sidebar-nav.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  navItems,
  isNavItemActive,
  findActiveNavItem,
} from "@/components/sidebar-nav";

describe("Sidebar Navigation", () => {
  describe("navigation items structure", () => {
    it("should have 12 navigation items", () => {
      assert.strictEqual(navItems.length, 12);
    });

    it("should have Dashboard as first item", () => {
      assert.strictEqual(navItems[0].name, "Dashboard");
      assert.strictEqual(navItems[0].href, "/");
    });

    it("should have Settings as last item", () => {
      assert.strictEqual(navItems[navItems.length - 1].name, "Settings");
    });

    it("should have unique names for all items", () => {
      const names = navItems.map((item) => item.name);
      assert.strictEqual(new Set(names).size, names.length);
    });

    it("should have unique hrefs for all items", () => {
      const hrefs = navItems.map((item) => item.href);
      assert.strictEqual(new Set(hrefs).size, hrefs.length);
    });

    it("should have all hrefs starting with /", () => {
      for (const item of navItems) {
        assert.ok(
          item.href.startsWith("/"),
          `${item.name} href should start with /`,
        );
      }
    });
  });

  describe("isNavItemActive", () => {
    it("should match exact path for Dashboard /", () => {
      assert.strictEqual(isNavItemActive("/", "/"), true);
    });

    it("should not match sub-paths for Dashboard /", () => {
      // The root "/" must NOT match "/courses" because of the
      // itemHref !== "/" guard preventing startsWith from matching everything.
      assert.strictEqual(isNavItemActive("/courses", "/"), false);
    });

    it("should match exact path for /courses", () => {
      assert.strictEqual(isNavItemActive("/courses", "/courses"), true);
    });

    it("should match sub-path for /courses", () => {
      assert.strictEqual(isNavItemActive("/courses/new", "/courses"), true);
    });

    it("should match deep sub-path for /courses", () => {
      assert.strictEqual(
        isNavItemActive("/courses/123/edit", "/courses"),
        true,
      );
    });

    it("should not match unrelated path", () => {
      assert.strictEqual(isNavItemActive("/users", "/courses"), false);
    });

    it("should match /content/create for Content Creator", () => {
      assert.strictEqual(
        isNavItemActive("/content/create", "/content/create"),
        true,
      );
    });

    it("should match /content for Content Library", () => {
      assert.strictEqual(isNavItemActive("/content", "/content"), true);
    });

    it("should match /invites sub-paths", () => {
      assert.strictEqual(isNavItemActive("/invites/new", "/invites"), true);
    });
  });

  describe("findActiveNavItem", () => {
    it("should find Dashboard for /", () => {
      assert.strictEqual(findActiveNavItem("/")?.name, "Dashboard");
    });

    it("should find Courses for /courses", () => {
      assert.strictEqual(findActiveNavItem("/courses")?.name, "Courses");
    });

    it("should find Courses for /courses/123", () => {
      assert.strictEqual(findActiveNavItem("/courses/123")?.name, "Courses");
    });

    it("should find Admin Users for /users", () => {
      assert.strictEqual(findActiveNavItem("/users")?.name, "Admin Users");
    });

    it("should find Settings for /settings", () => {
      assert.strictEqual(findActiveNavItem("/settings")?.name, "Settings");
    });

    it("should return undefined for unknown path", () => {
      assert.strictEqual(findActiveNavItem("/unknown-page"), undefined);
    });
  });
});
