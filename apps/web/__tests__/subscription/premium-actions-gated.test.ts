/**
 * MONEY-1142 — every premium page's server actions enforce the tier.
 *
 * Until this ticket, the paywall for `/risk`, `/tax`, `/documents`,
 * `/strategies` and `/quizzes` lived ENTIRELY in the client `PageGuard`. Those
 * actions checked authentication and nothing else — and a server action is
 * invocable directly, whatever the client rendered.
 *
 * That was reachable, not theoretical: `useFeatureFlags` read a `localStorage`
 * demo flag with no user gate, and `computeGuardDecision`'s demo branch returns
 * NO_GATE for every non-kill-switch route, skipping the plan check under it. A
 * signed-in FREE user could set `tradebook_demo_mode=true` in devtools and open
 * `/risk`. MONEY-1137 closed that door; this closed the room behind it.
 *
 * The important half of this file is the LAST test: it walks
 * `PAGE_TO_FEATURE_MAP` and fails when a premium route's action file has no
 * gate, so the next premium feature cannot ship ungated by omission. Pinning
 * only today's five files would leave the class open.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// MONEY-1149: the REAL map, not a re-parse of its source text. The completeness
// guard below reads the file as text on purpose (it needs to spot routes this
// test has no entry for), but an assertion ABOUT a specific route's value must
// bind to the shipped export or it can drift from it.
import { PAGE_TO_FEATURE_MAP } from "@/lib/constants/page-features";

const ROOT = join(__dirname, "..", "..");
const REPO = join(ROOT, "..", "..");

/** Paths starting `packages/` resolve from the repo root, others from apps/web. */
function resolve(rel: string): string {
  return rel.startsWith("packages/") ? join(REPO, rel) : join(ROOT, rel);
}

function read(rel: string): string {
  return readFileSync(resolve(rel), "utf8");
}

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Premium route → the action file(s) behind it, and the Feature each must
 * assert. Derived from `lib/constants/page-features.ts`; the completeness test
 * at the bottom proves this table has not drifted from that map.
 */
const GATED: Array<{ route: string; feature: string; files: string[] }> = [
  { route: "/risk", feature: "riskAnalysis", files: ["lib/actions/risk.ts"] },
  { route: "/tax", feature: "taxAnalysis", files: ["lib/actions/tax.ts"] },
  {
    route: "/documents",
    feature: "documentVault",
    files: ["lib/actions/documents.ts"],
  },
  {
    route: "/strategies",
    feature: "aiStrategies",
    files: ["lib/actions/strategy.ts"],
  },
  {
    route: "/quizzes",
    feature: "advancedCourses",
    files: ["lib/actions/quiz.ts"],
  },
  {
    // Two things differ from the rows above, both deliberate:
    //
    //  - the gate lives in the SERVICE, not the action. `learning.ts` resolves
    //    the planId and forwards it; `learning-logic.ts` applies the
    //    fail-closed check. That is a legitimate place for it — the same
    //    module serves apps/api, so gating there gates both surfaces at once.
    //  - the feature asserted is `advancedCourses`, and as of MONEY-1149 that
    //    is the ONLY paywall on this route — PAGE_TO_FEATURE_MAP no longer
    //    names `learningContent` for it. See LEARNING_GATE below.
    route: "/learning",
    feature: "advancedCourses",
    files: ["packages/services/src/learning-logic.ts"],
  },
];

/**
 * Premium routes whose enforcement is deliberately NOT a binary feature gate in
 * an action file. Each entry must say what enforces it instead and carry a
 * ticket — an unexplained exemption here is how a paywall quietly disappears.
 */
const KNOWN_GAPS: Array<{
  route: string;
  why: string;
  evidenceFile: string;
  evidence: RegExp;
}> = [
  {
    route: "/sage-tutor",
    // Enforcement is a QUOTA model, not an on/off gate: `/api/chat` resolves
    // the caller's planId (driving model routing) and `consumeAIQuery` meters
    // credits. A FREE user reaching it gets the free-tier experience, not the
    // premium one, so there is no data to leak — unlike /risk or /tax, where
    // the action returns the premium artifact wholesale.
    why: "credit metering + plan-based model routing in /api/chat",
    evidenceFile: "app/api/chat/route.ts",
    evidence: /consumeAIQuery/,
  },
];

/**
 * MONEY-1149 — RESOLVED. `/learning` used to map to `learningContent`, so
 * PageGuard blocked FREE users from the page, while the lesson TEXT behind it
 * was gated only by `advancedCourses` (ADVANCED content only). A FREE caller
 * could read any BASIC/INTERMEDIATE lesson in full via the server action while
 * being bounced from the page that renders exactly that content.
 *
 * Resolved in favour of the CODE: the map entry is now `null`, matching
 * `/analysis` and `/discover` after MONEY-394, and matching middleware, which
 * already had `/learning(.*)` in PUBLIC_ROUTE_PATTERNS.
 *
 * Worth stating precisely, because "learningContent is unenforced" is the
 * tempting and WRONG summary: it is enforced, just not on this surface.
 * `/api/storage/stream` checks it before serving any non-document path, so
 * premium lesson videos and PDFs remain PREMIUM/ULTIMATE-only no matter what
 * the page map says. That is why opening the page is safe — the paywall is on
 * the bytes.
 *
 * This constant survives the fix on purpose: the defect was a DISAGREEMENT
 * between enforcement layers, so the assertions below pin the resolution in
 * both directions rather than being deleted along with the bug.
 */
const LEARNING_GATE = {
  route: "/learning" as const,
  /** The gate on lesson TEXT, and the only paywall on that path. */
  enforced: "advancedCourses",
  /** Gates the premium MEDIA, in the storage-stream route — not this surface. */
  mediaFeature: "learningContent",
  mediaGateFile: "app/api/storage/stream/[...path]/route.ts",
  ticket: "MONEY-1149",
};

describe("MONEY-1142 — premium actions enforce the tier server-side", () => {
  for (const { route, feature, files } of GATED) {
    for (const file of files) {
      it(`${route} → ${file} asserts ${feature}`, () => {
        const code = stripComments(read(file));
        assert.match(
          code,
          new RegExp(
            `(requireFeature|hasFeatureAccess)[\\s\\S]{0,120}?"${feature}"`
          ),
          `${file} must check the ${feature} feature server-side — the client ` +
            `PageGuard is not a paywall, it is a UX affordance`
        );
      });
    }
  }

  it("[regression] every authenticated path in documents.ts is gated", () => {
    // The vault's value IS the stored documents, so gating only the upload
    // would lock the button and leave the data reachable. One gate per
    // authenticated entry point.
    const code = stripComments(read("lib/actions/documents.ts"));
    const authChecks = code.match(/getAuthenticatedUser\(\)/g)?.length ?? 0;
    const gates = code.match(/requireFeature\(/g)?.length ?? 0;
    assert.ok(authChecks > 0, "sanity: the scan found the auth calls");
    assert.equal(
      gates,
      authChecks,
      `${authChecks} authenticated entry points but ${gates} tier gates — ` +
        `a read path is almost certainly open`
    );
  });

  it("the gate fails CLOSED and does not cache its answer", () => {
    const code = stripComments(read("lib/actions/premium-gate.ts"));
    // A failed subscription read must deny, not allow. Failing open during an
    // outage hands premium data to whoever asks.
    assert.match(
      code,
      /catch[\s\S]{0,120}?planId = null/,
      "a failed subscription lookup must deny access"
    );
    assert.match(code, /if \(planId && hasFeatureAccess/);
    // Standing rule: never cache a fail-open default. This helper must not
    // introduce a cache of its own — the determinacy-aware one lives in
    // lib/subscription/access-cache.ts.
    assert.doesNotMatch(
      code,
      /setCached|getCached/,
      "do not cache entitlement decisions here — 'couldn't determine' must " +
        "stay distinct from 'denied', which this helper cannot express"
    );
  });

  it("uses the raw planId, not the collapsing access view", () => {
    // learning.ts learned this the hard way: hasFeatureAccess resolves legacy
    // ids itself, but the access view collapses an unknown id to FREE and would
    // re-lock a paying user on a legacy plan.
    const code = stripComments(read("lib/actions/premium-gate.ts"));
    assert.match(code, /getSubscription/);
    assert.doesNotMatch(code, /getSubscriptionAccess|checkFeatureAccess/);
  });

  /**
   * The durable guard. Everything above pins the five files fixed today; this
   * one fails when a NEW premium route appears in PAGE_TO_FEATURE_MAP without
   * a corresponding entry here — i.e. it makes the omission loud instead of
   * silent.
   */
  it("[completeness] every premium route in PAGE_TO_FEATURE_MAP is covered", () => {
    const map = read("lib/constants/page-features.ts");
    const body = map.slice(map.indexOf("PAGE_TO_FEATURE_MAP"));

    // Routes mapped to a non-null Feature are the premium ones.
    const premium = [...body.matchAll(/"(\/[^"]+)":\s*"([a-zA-Z]+)"/g)].map(
      (m) => ({ route: m[1]!, feature: m[2]! })
    );

    assert.ok(
      premium.length >= 5,
      `expected to parse several premium routes, found ${premium.length} — ` +
        `the map's shape changed and this guard is no longer reading it`
    );

    const covered = new Set([
      ...GATED.map((g) => g.route),
      ...KNOWN_GAPS.map((g) => g.route),
    ]);
    const uncovered = premium
      .filter((p) => !covered.has(p.route))
      .map((p) => `${p.route} (${p.feature})`);

    assert.deepEqual(
      uncovered,
      [],
      "these premium routes have no server-side gate asserted in this file. " +
        "Add the action file to GATED above AND gate it — a client-only " +
        "paywall is not a paywall. If enforcement genuinely lives elsewhere, " +
        "add it to KNOWN_GAPS with the evidence and a ticket"
    );
  });

  it("[completeness] every KNOWN_GAP's stated enforcement actually exists", () => {
    // An exemption is only honest while the thing it points at is real. If
    // `consumeAIQuery` is refactored out of /api/chat, this exemption becomes
    // a hole and must fail rather than keep excusing the route.
    for (const gap of KNOWN_GAPS) {
      const code = stripComments(read(gap.evidenceFile));
      assert.match(
        code,
        gap.evidence,
        `${gap.route} is exempted because of "${gap.why}", but that mechanism ` +
          `is no longer present in ${gap.evidenceFile} — the exemption is now ` +
          `an unguarded premium route`
      );
    }
  });

  it(`${LEARNING_GATE.ticket}: the two enforcement layers now AGREE on /learning`, () => {
    // The original defect was not "a route is ungated" — it was two layers
    // disagreeing, PageGuard blocking a page whose content the server would
    // hand to the same user on request. So this asserts the agreement, not
    // just the new value: either half drifting back re-opens the bug.
    assert.equal(
      PAGE_TO_FEATURE_MAP[LEARNING_GATE.route],
      null,
      `${LEARNING_GATE.route} must stay ungated at the page level. Naming a ` +
        `feature here without enforcing it server-side is the ${LEARNING_GATE.ticket} ` +
        `bug: PageGuard blocks the UI while the server action still returns ` +
        `the content to a direct caller.`
    );

    const code = stripComments(read("packages/services/src/learning-logic.ts"));
    assert.match(
      code,
      new RegExp(`"${LEARNING_GATE.enforced}"`),
      `the ADVANCED-course gate is now the ONLY paywall on ${LEARNING_GATE.route} — ` +
        `if it goes, premium course content becomes free with nothing left to stop it`
    );
  });

  it(`${LEARNING_GATE.ticket}: premium lesson MEDIA stays gated after opening the page`, () => {
    // The load-bearing assumption behind setting the map entry to null. If the
    // storage-stream gate were ever removed, ungating the page would turn from
    // a funnel decision into giving away the premium videos and PDFs — so the
    // two changes must never be made independently.
    const code = stripComments(read(LEARNING_GATE.mediaGateFile));
    assert.match(
      code,
      new RegExp(
        `hasFeatureAccess[\\s\\S]{0,80}?"${LEARNING_GATE.mediaFeature}"`
      ),
      `${LEARNING_GATE.mediaGateFile} no longer enforces ` +
        `"${LEARNING_GATE.mediaFeature}". That gate is what keeps premium ` +
        `lesson videos and PDFs paid now that ${LEARNING_GATE.route} is an ` +
        `open page — without it, ${LEARNING_GATE.ticket}'s resolution leaks ` +
        `the actual premium content, not just the course listing.`
    );
  });

  it(`${LEARNING_GATE.ticket}: re-gating /learning must gate the SERVER, not just the page`, () => {
    // The deliberate escape hatch. Making learning premium again is a valid
    // product decision — but doing it by restoring the map entry alone
    // recreates the exact leak, because PageGuard is a UI affordance and the
    // server actions are reachable directly. This fails loudly in that case
    // and passes once the service enforces it too.
    const mapped = PAGE_TO_FEATURE_MAP[LEARNING_GATE.route];
    if (mapped === null) return; // current, intended state

    const code = stripComments(read("packages/services/src/learning-logic.ts"));
    assert.match(
      code,
      new RegExp(`"${String(mapped)}"`),
      `PAGE_TO_FEATURE_MAP now names "${String(mapped)}" for ` +
        `${LEARNING_GATE.route}, but learning-logic.ts does not enforce it. ` +
        `PageGuard alone is not a paywall — a FREE caller can still invoke ` +
        `getLessonByIdAction directly. This is ${LEARNING_GATE.ticket} ` +
        `re-opened: "${LEARNING_GATE.mediaFeature}" gates the MEDIA in ` +
        `${LEARNING_GATE.mediaGateFile}, and never gated lesson text.`
    );
  });

  it("[completeness] the action files named above actually exist", () => {
    // Guards the other way: a renamed/moved action file would make the
    // per-route tests read a stale path and silently stop asserting.
    for (const { files } of GATED) {
      for (const f of files) {
        assert.ok(existsSync(resolve(f)), `${f} no longer exists`);
      }
    }
  });
});
