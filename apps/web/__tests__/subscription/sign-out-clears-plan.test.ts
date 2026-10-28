/**
 * UNIT TEST — every sign-out path drops the persisted plan (MONEY-1134).
 *
 * ## The defect
 *
 * `clearCachedPlan()` in `lib/subscription/plan-cache.ts` is documented as
 * "the sign-out path" and was built for it — it clears the in-memory value,
 * drops `um_plan_v1` from localStorage, and bumps a generation so a fetch
 * already in flight cannot write the old plan back.
 *
 * It had ZERO production call sites. Tests only. So the persisted plan
 * outlived the session, and on a shared browser the next person hydrated the
 * previous user's billing tier.
 *
 * ## Scope, stated honestly
 *
 * This is NOT a privilege escalation. `entitlement-isolation.test.ts` pins that
 * no gate reads this value — it feeds the sidebar tier chip and some
 * walkthrough copy. But it is still someone else's billing tier rendered as
 * yours, on a machine they no longer have a session on.
 *
 * ## Why the test is shaped like this
 *
 * The defect was an ABSENT call, not a wrong one, and it survived because
 * nothing connected "a function documented for sign-out" to "the code that
 * signs out". So this walks every `signOut(` call site in the app and requires
 * each to clear the plan — directly, or by going through `instantSignOut`,
 * which does it centrally.
 *
 * Pure file parsing: no Clerk, no DOM, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");

/** Every .ts/.tsx under a directory, recursively, skipping build output. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "__tests__"
    ) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** LINE comments before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Files that actually INVOKE a Clerk sign-out.
 *
 * `signOut` appearing in a destructure (`const { signOut } = useClerk()`) is
 * not a call — matching that would flag the hook itself.
 */
function signOutCallSites(): Array<{ file: string; source: string }> {
  const hits: Array<{ file: string; source: string }> = [];
  for (const file of [
    ...walk(join(WEB, "app")),
    ...walk(join(WEB, "components")),
    ...walk(join(WEB, "lib")),
  ]) {
    const source = stripComments(readFileSync(file, "utf8"));
    // A call: `signOut({...})` or `signOut(` with args — not `{ signOut }`.
    if (/\bsignOut\s*\(/.test(source)) {
      hits.push({ file: file.slice(WEB.length + 1), source });
    }
  }
  return hits;
}

describe("MONEY-1134 — the persisted plan does not outlive the session", () => {
  it("sanity: sign-out call sites are actually found", () => {
    // Without this, a refactor that renames the Clerk hook would make every
    // assertion below vacuously pass — the same shape as the original bug.
    const sites = signOutCallSites();
    assert.ok(
      sites.length >= 2,
      `found only ${sites.length} signOut call sites — the walker is not ` +
        `seeing the app and this guard is blind`
    );
  });

  it("instantSignOut clears the plan, and does so synchronously", () => {
    const src = stripComments(
      readFileSync(join(WEB, "lib/auth/sign-out.ts"), "utf8")
    );
    assert.match(src, /clearCachedPlan\(\)/, "instantSignOut must clear it");

    // Ordering matters: this is pure localStorage work and must happen even if
    // `signOut()` rejects or the hard-navigate races it. Inside the `.finally`
    // it would be a coin flip against `window.location.replace`.
    const clearAt = src.indexOf("clearCachedPlan()");
    const signOutAt = src.indexOf("signOut({ redirectUrl })");
    assert.ok(clearAt > -1 && signOutAt > -1);
    assert.ok(
      clearAt < signOutAt,
      "clearCachedPlan must run BEFORE the session is revoked, not in the " +
        "promise chain that races a hard navigation"
    );
  });

  it("EVERY sign-out call site clears the plan or delegates to instantSignOut", () => {
    for (const { file, source } of signOutCallSites()) {
      const clears =
        /clearCachedPlan\s*\(/.test(source) ||
        /instantSignOut\s*\(/.test(source);
      assert.ok(
        clears,
        `${file} calls signOut() but neither calls clearCachedPlan() nor goes ` +
          `through instantSignOut(). The persisted plan (um_plan_v1) will ` +
          `outlive the session, and on a shared browser the next user ` +
          `hydrates this user's billing tier (MONEY-1134).`
      );
    }
  });

  it("clearCachedPlan still does the three things sign-out depends on", () => {
    // If any of these is dropped, the call sites above become decorative.
    const src = stripComments(
      readFileSync(join(WEB, "lib/subscription/plan-cache.ts"), "utf8")
    );
    const fn = /export function clearCachedPlan\(\)[\s\S]*?\n\}/.exec(src);
    assert.ok(fn, "clearCachedPlan not found");
    const body = fn[0];

    assert.match(body, /cachedPlan = null/, "clears the in-memory value");
    assert.match(body, /dropPersistedPlan\(\)/, "drops localStorage");
    assert.match(
      body,
      /generation \+= 1/,
      "bumps the generation — without it a slow in-flight fetch can resurrect " +
        "and re-persist the previous user's plan after sign-out"
    );
  });
});
