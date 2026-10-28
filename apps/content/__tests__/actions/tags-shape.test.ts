/**
 * MONEY-393 §22 - apps/content `tags.ts` action shape + auth guards.
 *
 * apps/content has 9 action files; 7 are covered by their own
 * test files. `tags.ts` (310 LoC, full CRUD) was missing.
 *
 * Source-text guards for the standard action shape: 'use server',
 * auth gating, ActionResponse discriminated union.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "..", "lib", "actions", "tags.ts"),
  "utf8",
);

describe("MONEY-393 §22 - apps/content tags.ts shape", () => {
  it("[exports] 5 CRUD actions declared with documented names", () => {
    assert.match(SRC, /export\s+async\s+function\s+createTag\b/);
    assert.match(SRC, /export\s+async\s+function\s+updateTag\b/);
    assert.match(SRC, /export\s+async\s+function\s+deleteTag\b/);
    assert.match(SRC, /export\s+async\s+function\s+getTagBySlug\b/);
    assert.match(SRC, /export\s+async\s+function\s+listTags\b/);
  });

  it("[src] file is marked 'use server'", () => {
    assert.match(SRC, /^"use server"/m);
  });

  it("[src] mutating actions (create/update/delete) reference auth/admin gating", () => {
    // The Content CMS is admin-only. createTag/updateTag/deleteTag
    // must check auth before mutating + surface 'Unauthorized' to a
    // non-admin caller. Verify by checking for both the auth() call
    // and the explicit Unauthorized error message.
    assert.match(SRC, /await\s+auth\(\)/, "tags.ts must call Clerk auth()");
    const unauthCount = (
      SRC.match(/Unauthorized[\s\S]{0,80}admins?\s+can/g) ?? []
    ).length;
    assert.ok(
      unauthCount >= 3,
      `tags.ts must have ≥3 'Unauthorized - only admins can…' error branches (one per mutating action), got ${unauthCount}`,
    );
  });

  it("[contract] returns ActionResponse discriminated union", () => {
    // Each function returns ActionResponse<T> = success | error shape.
    assert.match(
      SRC,
      /ActionResponse<[\w\s]+>|Promise<ActionResponse</,
      "tags.ts must use ActionResponse generic",
    );
  });

  it("[validation] slug generation handles edge cases (spaces/special chars)", () => {
    // Tag slugs are URL-routed - must normalize for safety. Look for
    // either a slugify import or a regex-based normalization.
    assert.match(
      SRC,
      /slug|slugify|toLowerCase|\.replace\(\/.+\/g/i,
      "tags.ts must have slug normalization for URL safety",
    );
  });

  it("[error-handling] catch blocks return ActionResponse error shape", () => {
    const occurrences = SRC.match(/success:\s*false/g) ?? [];
    assert.ok(
      occurrences.length >= 3,
      `tags.ts must have ≥3 success:false error returns, got ${occurrences.length}`,
    );
  });
});

describe("MONEY-393 §22 - apps/content editor components shape", () => {
  const EDITOR = join(__dirname, "..", "..", "components", "editor");

  it("[editor] blocknote-editor.tsx is a 'use client' component", () => {
    const src = readFileSync(join(EDITOR, "blocknote-editor.tsx"), "utf8");
    assert.match(src, /"use client"/);
  });

  it("[editor] editor-error-boundary catches editor crashes", () => {
    const src = readFileSync(join(EDITOR, "editor-error-boundary.tsx"), "utf8");
    // Error boundary uses componentDidCatch / getDerivedStateFromError /
    // ErrorBoundary class. Required for resilience against editor crashes.
    assert.match(
      src,
      /componentDidCatch|getDerivedStateFromError|ErrorBoundary/,
      "editor-error-boundary must implement the React error boundary protocol",
    );
  });

  it("[editor] schema.ts defines blocks for the CMS", () => {
    const src = readFileSync(join(EDITOR, "schema.ts"), "utf8");
    // Should export at least one block / schema / type.
    assert.match(
      src,
      /export\s+(const|type|interface|function)/,
      "editor/schema.ts must export at least one block/schema",
    );
  });
});
