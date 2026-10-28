/**
 * MONEY-1209 — the console redaction boundary in `workers/src/log-boundary.ts`.
 *
 * Two halves, and both are needed:
 *
 *   1. The wrapper itself redacts. Asserted against the REAL exported function,
 *      never a re-declared copy — `auth-middleware.test.ts` documents what that
 *      mistake costs: 15 green cases asserting a copy while the real gate was
 *      fail-open.
 *   2. The entry point actually installs it. A boundary nobody calls redacts
 *      nothing, and every unit test in half 1 stays green while it does — so the
 *      wiring is asserted from `workers/src/index.ts` on disk, including its
 *      position relative to the tracer.
 *
 * Assertions run through `util.format` (what `console.error` actually writes to
 * stdout) AND through `util.inspect(..., { depth: null })` (what a JSON sink
 * such as pino → Datadog or Cloud Logging's structured payload would receive).
 * Checking only the first would pass on a payload the second still publishes.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import util from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./_support/repo-root";

import {
  installLogRedaction,
  uninstallLogRedaction,
  isLogRedactionInstalled,
} from "../src/log-boundary";

const SECRETS = ["SECRET1", "SECRET2", "TOKENX"] as const;

/** The ky `HTTPError` shape named in the ticket. */
function fakeKyError(): Error {
  return Object.assign(
    new Error("Request failed with status code 403 Forbidden"),
    {
      name: "HTTPError",
      request: {
        headers: { cookie: "ak_bmsc=SECRET1; bm_sz=SECRET2" },
        url: "https://www.nseindia.com/api/equity-stockIndices",
      },
      options: { headers: { authorization: "Bearer TOKENX" } },
    },
  );
}

/**
 * Resolved ONCE, at MODULE scope — MONEY-1327.
 *
 * `repoRoot()` throws when its anchor stops landing on the workspace root, and
 * WHERE that throw happens decides whether anyone sees it: from a `describe`
 * body node reports a dropped suite (`not ok`, `# fail 0`, sometimes exit 0);
 * from module scope it fails the FILE. Same error, loud instead of silent — see
 * the longer note in `auth-middleware.test.ts`, which measured exit 0.
 */
const REPO_ROOT = repoRoot();

/** Returns "" rather than throwing — a throw in a describe body is reported by
 *  node as a dropped suite with `fail 0` and exit 0. */
function readRepoFile(...parts: string[]): string {
  const full = join(REPO_ROOT, ...parts);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

describe("MONEY-1209 - workers console redaction boundary", () => {
  let calls: unknown[][] = [];
  let realError: typeof console.error;
  let realWarn: typeof console.warn;
  let realLog: typeof console.log;

  beforeEach(() => {
    // The entry point may have installed the boundary in another test file's
    // import graph; start from a known-clean console every time.
    uninstallLogRedaction();
    calls = [];
    realError = console.error;
    realWarn = console.warn;
    realLog = console.log;
    const spy = (...args: unknown[]): void => {
      calls.push(args);
    };
    console.error = spy;
    console.warn = spy;
    console.log = spy;
  });

  afterEach(() => {
    uninstallLogRedaction();
    console.error = realError;
    console.warn = realWarn;
    console.log = realLog;
  });

  /** Everything the sinks would see for the recorded call at `index`. */
  function emitted(index = 0): string {
    const args = calls[index] ?? [];
    return util.format(...args) + "\n" + util.inspect(args, { depth: null });
  }

  it("[boundary] strips cookies + bearer from a ky error passed to console.error", () => {
    const err = fakeKyError();

    // CONTROL: without the boundary the same call leaks all three.
    console.error("[nse-sync] failed:", err);
    const leaked = emitted(0);
    for (const secret of SECRETS) {
      assert.ok(
        leaked.includes(secret),
        `control failed: ${secret} was not emitted unredacted, so the ` +
          `assertion below would pass for the wrong reason`,
      );
    }

    calls = [];
    installLogRedaction();
    console.error("[nse-sync] failed:", err);

    assert.equal(calls.length, 1, "the call must still reach the console");
    const safe = emitted(0);
    for (const secret of SECRETS) {
      assert.ok(!safe.includes(secret), `${secret} survived: ${safe}`);
    }
    // The parts an on-call engineer needs must still be there.
    assert.ok(safe.includes("[nse-sync] failed:"), safe);
    assert.ok(safe.includes("403 Forbidden"), safe);
    assert.ok(safe.includes("equity-stockIndices"), safe);
  });

  it("[boundary] covers console.warn and console.log too, not just error", () => {
    installLogRedaction();

    console.warn("[nse-client] retrying with", {
      cookie: "ak_bmsc=SECRET1",
    });
    console.log("session header: ak_bmsc=SECRET2; bm_sz=SECRET1");

    assert.equal(calls.length, 2);
    for (const index of [0, 1]) {
      const safe = emitted(index);
      for (const secret of SECRETS) {
        assert.ok(!safe.includes(secret), `${secret} survived: ${safe}`);
      }
    }
    assert.ok(emitted(1).includes("ak_bmsc=[REDACTED]"), emitted(1));
  });

  it("[boundary] redacts a bare string argument (no object to walk)", () => {
    // `console.error(\`... ${err}\`)` collapses the error to a string before it
    // ever reaches us; only the value scanner can help there.
    installLogRedaction();
    console.error(
      "[nse-sync] handshake failed with Cookie: ak_bmsc=SECRET1, auth Bearer TOKENX",
    );
    const safe = emitted(0);
    for (const secret of SECRETS.filter((s) => s !== "SECRET2")) {
      assert.ok(!safe.includes(secret), `${secret} survived: ${safe}`);
    }
    assert.ok(safe.includes("handshake failed"), safe);
  });

  it("[boundary] redacts an opaque credential only the key rule can catch", () => {
    // The ticket's own payload is covered TWICE over — `ak_bmsc=...` is a
    // recognisable value shape AND sits under a `cookie` key — so it cannot
    // tell the two rules apart. Every credential here is a shapeless blob whose
    // only tell is the key it hangs off, which is what every broker API key we
    // hold actually looks like. Mutation-checked: deleting the key rule leaves
    // this the only red case in the file.
    installLogRedaction();
    console.error("[broker-sync] refresh failed:", {
      options: {
        headers: {
          "x-api-key": "OPAQUE1",
          token: "OPAQUE2",
          api_key: "OPAQUE3",
        },
      },
      config: { headers: { Authorization: "OPAQUE4" } },
      broker: "ZERODHA",
    });

    const safe = emitted(0);
    for (const secret of ["OPAQUE1", "OPAQUE2", "OPAQUE3", "OPAQUE4"]) {
      assert.ok(!safe.includes(secret), `${secret} survived: ${safe}`);
    }
    assert.ok(safe.includes("ZERODHA"), "diagnostics must survive");
  });

  it("[boundary] is idempotent - a second install neither re-wraps nor loses the original", () => {
    installLogRedaction();
    const afterFirst = console.error;

    installLogRedaction();
    assert.equal(
      console.error,
      afterFirst,
      "second install replaced the wrapper - the original is now unreachable",
    );

    // A single uninstall must be enough to get all the way back.
    const spy = console.error;
    uninstallLogRedaction();
    assert.notEqual(console.error, afterFirst);
    assert.equal(isLogRedactionInstalled(), false);
    assert.notEqual(spy, console.error);

    // And the restored console is the untouched spy: still redacting nothing.
    console.error("ak_bmsc=SECRET1");
    assert.ok(emitted(0).includes("SECRET1"));
  });

  it("[boundary] never lets a broken console take down the job", () => {
    console.error = () => {
      throw new Error("EPIPE");
    };
    installLogRedaction();
    assert.doesNotThrow(() => console.error("anything"));
  });

  it("[boundary] tracks its own installed state", () => {
    assert.equal(isLogRedactionInstalled(), false);
    installLogRedaction();
    assert.equal(isLogRedactionInstalled(), true);
    uninstallLogRedaction();
    assert.equal(isLogRedactionInstalled(), false);
    // Uninstalling twice must not throw or clobber anything.
    assert.doesNotThrow(() => uninstallLogRedaction());
  });
});

describe("MONEY-1209 - the entry point installs the boundary", () => {
  const entry = readRepoFile("workers", "src", "index.ts");

  it("[wiring] workers/src/index.ts is readable", () => {
    assert.ok(entry.length > 0, "could not read workers/src/index.ts");
  });

  it("[wiring] imports and CALLS installLogRedaction", () => {
    assert.match(
      entry,
      /import\s*\{\s*installLogRedaction\s*\}\s*from\s*["']\.\/log-boundary["']/,
      "workers/src/index.ts no longer imports the log boundary",
    );
    assert.match(
      entry,
      /^\s*installLogRedaction\(\);/m,
      "workers/src/index.ts imports the boundary but never installs it - " +
        "every unit test above stays green while the console leaks",
    );
  });

  it("[wiring] installs before anything else can log", () => {
    // Anchored to line starts: both names also occur inside the surrounding
    // "why" comments, and `indexOf` would happily compare a comment to a
    // statement and report an ordering that does not exist.
    const install = entry.search(/^installLogRedaction\(\);/m);
    const tracer = entry.search(/^initTracer\(/m);
    assert.ok(
      install >= 0,
      "installLogRedaction() is not a top-level statement",
    );
    assert.ok(tracer >= 0, "initTracer(...) is not a top-level statement");
    assert.ok(
      install < tracer,
      "the boundary must be the first statement in the entry point - " +
        "anything that logs before it logs unredacted, and boot-time failures " +
        "are exactly the errors that still carry their request headers",
    );
  });
});

describe("[wiring] every long-lived SERVICE entrypoint installs the boot sequence", () => {
  // This suite pinned `workers/src/index.ts` BY NAME. MONEY-1309 added a second
  // entrypoint (`dist/tiingo-realtime.js`, an always-on Cloud Run service on the
  // same image via a `command:` override) which inherited none of the boot
  // installs — no log redaction, no tracer, no IPv4-first DNS — without failing
  // anything here, because the guard could not see a file it did not name.
  //
  // SCOPE: long-lived SERVICES only, derived from the `command:` overrides in
  // the Cloud Build specs plus the image's default entry. The one-shot job
  // entrypoints (`../scripts/jobs/*.ts`) install NONE of the three and never
  // have — measured, not assumed. That is a real pre-existing gap and it is
  // stated here rather than silently folded in, because widening this guard to
  // them is a change to five scripts with its own risk, not a side effect of
  // adding a service. A process that runs for weeks streaming logs and holding
  // one TLS connection is a different risk from one that runs for 400 seconds.
  const serviceEntries = (): string[] => {
    const out = new Set<string>(["src/index.ts"]);
    const tsup = readRepoFile("workers", "tsup.config.ts");
    const entryBlock = /entry\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(tsup);
    assert.ok(entryBlock, "could not parse tsup's `entry` map");
    const byName = new Map<string, string>();
    for (const m of entryBlock[1]!.matchAll(
      /["']?([A-Za-z0-9_-]+)["']?\s*:\s*["']([^"']+)["']/g,
    )) {
      byName.set(m[1]!, m[2]!);
    }
    for (const spec of ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"]) {
      const src = readRepoFile("workers", spec);
      for (const m of src.matchAll(
        /command:\s*\[\s*"node"\s*,\s*"dist\/([A-Za-z0-9_-]+)\.js"/g,
      )) {
        const target = byName.get(m[1]!);
        assert.ok(
          target,
          `cloudbuild runs dist/${m[1]}.js but tsup has no such entry`,
        );
        out.add(target!);
      }
    }
    return [...out];
  };

  it("[premise] the derivation finds the realtime service, not just index", () => {
    // If either parse breaks, the set collapses to `index.ts` alone and every
    // case below passes while watching one file — the exact vacuity that let
    // the second entrypoint through in the first place.
    const e = serviceEntries();
    assert.ok(
      e.length >= 2,
      `derived only ${e.length} service entrypoint(s): ${JSON.stringify(e)} — ` +
        "the tsup entry map or the cloudbuild `command:` override stopped parsing",
    );
    assert.ok(
      e.some((x) => x.includes("realtime")),
      `the realtime service is missing from ${JSON.stringify(e)}`,
    );
  });

  for (const rel of serviceEntries()) {
    it(`${rel} installs redaction, the tracer and IPv4-first DNS`, () => {
      const src = readRepoFile("workers", rel);
      assert.ok(src.length > 0, `service entrypoint unreadable: ${rel}`);
      for (const [needle, why] of [
        [
          "installLogRedaction()",
          "its logs leave unredacted, for the life of the process",
        ],
        ["initTracer(", "the service has no APM at all"],
        ["ipv4first", "Cloud Run's resolver tries IPv6 first and stalls"],
      ] as const) {
        assert.ok(
          src.includes(needle),
          `${rel} never calls ${needle} — ${why}. Each tsup entrypoint is a ` +
            "SEPARATE process and inherits nothing from index.ts.",
        );
      }
    });
  }
});
