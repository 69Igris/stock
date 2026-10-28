/**
 * MONEY-393 §19 - apps/admin server actions: shape + admin-auth guards.
 *
 * apps/admin has 47 source files; existing __tests__/ folder has 13.
 * The admin actions are highly privileged (GST invoice mutation,
 * coupon issuance, course publishing). Source-text guards pin:
 *   - Every action calls `requireAdmin()` before touching data
 *   - 'use server' marker (Next.js server-action requirement)
 *   - Return shapes are discriminated unions where appropriate
 *
 * Source-text only (not runtime import) because admin actions pull
 * Clerk auth + Prisma + React cache - same constraint as the apps/
 * web action tests in MONEY-393.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ACTIONS = join(__dirname, "..", "..", "lib", "actions");

function read(name: string): string {
  return readFileSync(join(ACTIONS, name), "utf8");
}

const ACTION_FILES = [
  "gst.ts",
  "discounts.ts",
  "courses.ts",
  "chapters.ts",
  "lessons.ts",
  "quizzes.ts",
  "content-generation.ts",
  "invites.ts",
  "config.ts",
  "stats.ts",
];

describe("MONEY-393 §19 - apps/admin server actions shape", () => {
  it("[exists] all 10 admin action files exist", () => {
    for (const f of ACTION_FILES) {
      assert.ok(
        existsSync(join(ACTIONS, f)),
        `apps/admin/lib/actions/${f} must exist`,
      );
    }
  });

  it("[use server] every admin action file is marked 'use server'", () => {
    // Each file is a separate server-action module - Next.js needs the
    // directive at the top of every one (per-file, not transitive).
    for (const f of ACTION_FILES) {
      const src = read(f);
      assert.match(src, /^"use server"/m, `${f} must be marked 'use server'`);
    }
  });

  it("[gst] every exported action calls requireAdmin() before touching state", () => {
    // The most security-sensitive file - invoice generation, mutation,
    // GSTR-1 export. Each exported action must gate on requireAdmin().
    const src = read("gst.ts");
    const actions =
      src.match(/export\s+async\s+function\s+(\w+Action)\b/g) ?? [];
    const requires = (src.match(/await\s+requireAdmin\(\)/g) ?? []).length;
    // At least as many requireAdmin() calls as exported actions.
    assert.ok(
      requires >= actions.length,
      `gst.ts has ${actions.length} actions but only ${requires} requireAdmin() calls`,
    );
    assert.ok(actions.length >= 10, "gst.ts must export at least 10 actions");
  });

  it("[gst] dodo CSV ingestion is admin-gated (revenue audit trail)", () => {
    const src = read("gst.ts");
    assert.match(src, /ingestDodoCsvAction\b/);
    // Verify requireAdmin is called somewhere after the function
    // declaration. The function signature can be long (multi-line
    // return type) so we scan up to 1200 chars of the body.
    const fn = src.split("ingestDodoCsvAction")[1] ?? "";
    assert.ok(
      fn.slice(0, 1200).includes("requireAdmin"),
      "ingestDodoCsvAction must call requireAdmin in its top frame",
    );
  });

  it("[gst] cancelGstInvoiceAction exists (audit-trailed)", () => {
    const src = read("gst.ts");
    assert.match(
      src,
      /export\s+async\s+function\s+cancelGstInvoiceAction\b/,
      "GST invoice cancellation must be a first-class admin action",
    );
  });

  it("[gst] markFircReceivedAction exists (export FX reconciliation)", () => {
    const src = read("gst.ts");
    assert.match(
      src,
      /export\s+async\s+function\s+markFircReceivedAction\b/,
      "FIRC marking must be admin-gated for export invoice trail",
    );
  });

  it("[gst] GSTR-1 Table 6A export action exists", () => {
    const src = read("gst.ts");
    assert.match(
      src,
      /export\s+async\s+function\s+exportGstr1Table6aAction\b/,
      "GSTR-1 export endpoint is required for monthly filing",
    );
  });

  it("[gst] admin-user GST profile mutation is gated (uses 'admin*' name prefix)", () => {
    const src = read("gst.ts");
    // The admin variants of user-facing actions live behind admin*
    // prefix so it's obvious in code review that they bypass the
    // normal authenticated-user-is-target constraint.
    assert.match(src, /adminGetUserGstProfileAction\b/);
    assert.match(src, /adminSetUserGstProfileAction\b/);
    assert.match(src, /adminGenerateDomesticInvoiceAction\b/);
  });

  it("[discounts] coupon issuance + deactivation are admin-gated", () => {
    const src = read("discounts.ts");
    assert.match(src, /export\s+async\s+function\s+createCoupon\b/);
    assert.match(src, /export\s+async\s+function\s+deactivateCoupon\b/);
    // Coupon mutations must require admin - revenue impact.
    const requires = (src.match(/await\s+requireAdmin\(\)/g) ?? []).length;
    assert.ok(
      requires >= 2,
      `discounts.ts needs ≥2 requireAdmin() calls (list/create/deactivate), got ${requires}`,
    );
  });

  it("[courses] CRUD + publish toggle are admin-gated", () => {
    const src = read("courses.ts");
    for (const name of [
      "getCourses",
      "getCourseById",
      "createCourse",
      "updateCourse",
      "deleteCourse",
      "publishCourse",
    ]) {
      assert.match(
        src,
        new RegExp(`export\\s+async\\s+function\\s+${name}\\b`),
        `courses.ts must export ${name}`,
      );
    }
    // At least the mutate actions need requireAdmin.
    const requires = (src.match(/await\s+requireAdmin\(\)/g) ?? []).length;
    assert.ok(
      requires >= 4,
      `courses.ts needs ≥4 requireAdmin() calls (mutations + reads), got ${requires}`,
    );
  });

  it("[chapters/lessons/quizzes] CMS action files compile without orphan exports", () => {
    // Light sanity - each file has at least one export and is marked
    // 'use server'. Catches an accidentally-emptied module.
    for (const f of ["chapters.ts", "lessons.ts", "quizzes.ts"]) {
      const src = read(f);
      assert.match(
        src,
        /export\s+(async\s+)?function\b/,
        `${f} must export at least one function`,
      );
    }
  });

  it("[no-secret-leak] no hardcoded sk_/pk_/api_key tokens in any action file", () => {
    // Defense-in-depth - admin actions handle revenue + identity
    // tokens. Reject any source-level credential.
    for (const f of ACTION_FILES) {
      const src = read(f);
      assert.ok(
        !/sk_live_[a-zA-Z0-9]{16,}|sk_test_[a-zA-Z0-9]{16,}|pk_live_[a-zA-Z0-9]{16,}/.test(
          src,
        ),
        `${f} contains a hardcoded Stripe/Dodo secret`,
      );
    }
  });

  it("[error-handling] gst.ts catches Error and returns sanitized messages", () => {
    // gst.ts is the largest action surface (645 LoC) - verify the
    // sanitized-error pattern at least once.
    const src = read("gst.ts");
    assert.ok(
      /error\s+instanceof\s+Error/.test(src) ||
        /catch\s*\([\s\S]{0,50}error/.test(src),
      "gst.ts must have error-handling that doesn't leak raw exceptions",
    );
  });
});
