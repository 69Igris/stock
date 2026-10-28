/**
 * MONEY-1204 / 14e.3 — a fired data-engine alert must reach the Alerts tab.
 *
 * The evaluator files all six new kinds under NotificationType `SYSTEM`
 * (the Prisma enum has no members for them) and carries the precise kind in
 * `metadata.alertKind`. Its own comment claimed "the UI can already
 * discriminate" — but `alertKind` had ZERO readers repo-wide, so both
 * notification surfaces filtered on `type` against a five-entry allow-list and
 * a fired FLAG_TRANSITION landed under System beside broker-reauth
 * housekeeping: never under Alerts, never in the alerts tally, and on
 * /discover/news routed to the generic list instead of the alert cards.
 *
 * This file pins three things:
 *   1. the classifier promotes SYSTEM + alertKind, and ONLY that;
 *   2. every kind the evaluator maps to SYSTEM is covered — the list is read
 *      from the evaluator's own source, so a seventh kind is picked up here
 *      without anybody remembering to edit this file;
 *   3. the /discover/news MIRROR of the rule has not drifted from the
 *      canonical copy in app/notifications/client.tsx. (It is a mirror rather
 *      than an import because that page is a SERVER component and Next's
 *      flight loader turns every export of a "use client" module into a stub
 *      that throws when the server calls it.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Loading the client component in node ────────────────────────────────────
// Stub only its server-action edge (Clerk/Prisma pull in `react.cache`, which
// React 18 does not export); the classifier under test is the REAL one.

interface ModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as ModuleLoader;
const originalLoad = loader._load;
loader._load = function patchedLoad(
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request.endsWith(".css")) return {};
  if (request === "@/lib/actions/notifications") {
    return {
      markAsReadAction: async () => ({ success: true }),
      markAllAsReadAction: async () => ({ success: true }),
      clearAllReadAction: async () => ({ success: true }),
    };
  }
  return originalLoad.call(loader, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const notifications =
  require("../../app/notifications/client") as typeof import("../../app/notifications/client");
const {
  ALERT_NOTIFICATION_TYPES,
  alertKindOf,
  isAlertNotification,
  isSystemNotification,
} = notifications;

const ROOT = join(__dirname, "..", "..", "..", "..");
const EVALUATOR_SRC = readFileSync(
  join(ROOT, "workers", "src", "processors", "alert-evaluator.ts"),
  "utf8"
);
const NEWS_PAGE_SRC = readFileSync(
  join(__dirname, "..", "..", "app", "discover", "news", "page.tsx"),
  "utf8"
);

/** String literals inside `const NAME = [ … ]`. */
function extractStringArray(src: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*(?::[^=]*)?=\\s*\\[([^\\]]*)\\]`).exec(src);
  assert.ok(m, `could not find ${name} in source`);
  return Array.from((m[1] ?? "").matchAll(/"([^"]+)"/g)).map((x) => x[1] ?? "");
}

const DATA_ENGINE_KINDS = extractStringArray(
  EVALUATOR_SRC,
  "DATA_ENGINE_ALERT_KINDS"
);

describe("MONEY-1204 · alertKindOf", () => {
  it("reads a non-empty string alertKind", () => {
    assert.equal(alertKindOf({ alertKind: "MWPL_HIGH" }), "MWPL_HIGH");
    assert.equal(
      alertKindOf({ alertKind: "  FLAG_TRANSITION  " }),
      "FLAG_TRANSITION"
    );
  });

  it("is null for everything that is not one", () => {
    assert.equal(alertKindOf(null), null);
    assert.equal(alertKindOf(undefined), null);
    assert.equal(alertKindOf({}), null);
    assert.equal(alertKindOf({ alertKind: "" }), null);
    assert.equal(alertKindOf({ alertKind: "   " }), null);
    assert.equal(alertKindOf({ alertKind: 7 }), null);
    assert.equal(alertKindOf({ alertKind: ["MWPL_HIGH"] }), null);
    assert.equal(alertKindOf("MWPL_HIGH"), null);
  });
});

describe("MONEY-1204 · isAlertNotification", () => {
  it("the evaluator really does file these as SYSTEM", () => {
    // The premise of the whole fix. If this stops being true the mapping
    // changed and the classifier needs revisiting.
    assert.ok(DATA_ENGINE_KINDS.length >= 6, "no data-engine kinds found");
    const map =
      /DATA_ENGINE_NOTIFICATION_TYPE[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(
        EVALUATOR_SRC
      );
    assert.ok(map, "DATA_ENGINE_NOTIFICATION_TYPE not found");
    for (const kind of DATA_ENGINE_KINDS) {
      assert.match(
        map[1] ?? "",
        new RegExp(`${kind}:\\s*"SYSTEM"`),
        `${kind} is no longer mapped to SYSTEM`
      );
    }
  });

  it("a SYSTEM notification carrying metadata.alertKind IS an alert", () => {
    for (const kind of DATA_ENGINE_KINDS) {
      assert.equal(
        isAlertNotification({
          type: "SYSTEM",
          metadata: { alertKind: kind, symbol: "TCS" },
        }),
        true,
        `${kind} was not classified as an alert`
      );
    }
  });

  it("a SYSTEM notification WITHOUT an alertKind is NOT an alert", () => {
    // Sync-complete / broker-reauth / dead-letter housekeeping. Adding SYSTEM
    // to the type list wholesale would have dragged all of these into Alerts.
    assert.equal(
      isAlertNotification({ type: "SYSTEM", metadata: { jobId: "abc" } }),
      false
    );
    assert.equal(
      isAlertNotification({ type: "SYSTEM", metadata: null }),
      false
    );
    assert.equal(isAlertNotification({ type: "SYSTEM" }), false);
    assert.equal(
      isAlertNotification({ type: "BROKER_REAUTH", metadata: {} }),
      false
    );
    assert.equal(
      isAlertNotification({ type: "SYNC_COMPLETE", metadata: {} }),
      false
    );
  });

  it("the five typed alert kinds still classify as alerts", () => {
    for (const type of ALERT_NOTIFICATION_TYPES) {
      assert.equal(isAlertNotification({ type, metadata: {} }), true, type);
    }
  });

  it("a promoted alert is NOT also counted as System", () => {
    const fired = {
      type: "SYSTEM",
      metadata: { alertKind: "DELIVERY_SPIKE" },
    };
    assert.equal(isAlertNotification(fired), true);
    assert.equal(isSystemNotification(fired), false);
    // …while genuine housekeeping stays exactly where it was.
    const housekeeping = { type: "SYSTEM", metadata: { source: "dlq" } };
    assert.equal(isSystemNotification(housekeeping), true);
    assert.equal(isAlertNotification(housekeeping), false);
    assert.equal(
      isSystemNotification({ type: "PRICE_ALERT", metadata: {} }),
      false
    );
  });
});

describe("MONEY-1204 · /discover/news mirrors the canonical rule", () => {
  it("carries the same alert-type list", () => {
    assert.deepEqual(
      extractStringArray(NEWS_PAGE_SRC, "ALERT_NOTIFICATION_TYPES").sort(),
      [...ALERT_NOTIFICATION_TYPES].sort()
    );
  });

  it("promotes on metadata.alertKind, not on type alone", () => {
    assert.match(NEWS_PAGE_SRC, /function alertKindOf\(metadata: unknown\)/);
    assert.match(NEWS_PAGE_SRC, /\.alertKind/);
    assert.match(NEWS_PAGE_SRC, /return alertKindOf\(n\.metadata\) !== null;/);
  });

  it("splits BOTH side panels on that one classifier", () => {
    // Same predicate on both sides, so a row can never land in neither or both.
    assert.match(
      NEWS_PAGE_SRC,
      /alertCards[\s\S]{0,80}\.filter\(\(n\) => isAlertNotification\(n\)\)/
    );
    assert.match(
      NEWS_PAGE_SRC,
      /notifCards[\s\S]{0,80}\.filter\(\(n\) => !isAlertNotification\(n\)\)/
    );
    // …and the old type-only filter is gone.
    assert.equal(
      /filter\(\(n\) => ALERT_TYPES\.has\(n\.type\)\)/.test(NEWS_PAGE_SRC),
      false
    );
  });
});
