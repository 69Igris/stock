/**
 * Pub/Sub OIDC gate on `/jobs/*` (MONEY-288, de-shadowed by MONEY-1093).
 *
 * This file used to import nothing but `node:test` and re-declare the
 * middleware inline — so it asserted a COPY. Deleting the real gate in
 * `workers/src/index.ts` left all 15 cases green, on the one route family that
 * can trigger ~35 job processors with an arbitrary payload.
 *
 * The security-critical half is now imported for real: `shouldSkipHttpOidc`
 * decides whether an unauthenticated POST is accepted at all. MONEY-288 found it
 * gated behind `NODE_ENV === "production"`, which left QA Cloud Run open to
 * anyone who knew the URL.
 *
 * Source: workers/src/index-auth-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./_support/repo-root";

import {
  shouldSkipHttpOidc,
  DEPLOYED_ENVS,
  LOCAL_ENVS,
  createJobsAuthMiddleware,
} from "../src/index-auth-logic";

/**
 * Resolved ONCE, at MODULE scope — MONEY-1327, and the placement is the point.
 *
 * `repoRoot()` throws when its anchor stops landing on the workspace root. Call
 * it lazily from inside `readRepoFile` and that throw happens in a `describe`
 * BODY, which node reports as a dropped suite: `not ok`, `# fail 0`, and
 * **exit 0**. Measured on this very file — a deliberately broken anchor took it
 * from 21 cases to 17 and still exited 0, which CI reads as a pass.
 *
 * At module scope the same throw is a module-evaluation failure, so node fails
 * the FILE and exits 1. Same error, loud instead of silent.
 */
const REPO_ROOT = repoRoot();

/** Returns "" rather than throwing — a throw in a describe body is reported by
 *  node as a dropped suite with `fail 0` and exit 0. */
function readRepoFile(...parts: string[]): string {
  const full = join(REPO_ROOT, ...parts);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

describe("shouldSkipHttpOidc — the real decision, not a copy", () => {
  it("NEVER skips on production OR qa", () => {
    // Named LITERALLY, not iterated from DEPLOYED_ENVS. Iterating the constant
    // is self-referential: removing "qa" from it — which IS the MONEY-288
    // regression, verbatim — shrinks the loop and the test stays green. A
    // mutation run caught exactly that.
    for (const nodeEnv of ["production", "qa"]) {
      assert.equal(
        shouldSkipHttpOidc({ nodeEnv, enablePullSubscriber: "true" }),
        false,
        `${nodeEnv} must require a token even with ENABLE_PULL_SUBSCRIBER=true`,
      );
    }
  });

  it("keeps qa in the deployed set", () => {
    // The constant itself, pinned. QA Cloud Run being treated as non-deployed
    // is what left every /jobs/* route open to anyone with the URL.
    assert.ok(
      (DEPLOYED_ENVS as readonly string[]).includes("qa"),
      'DEPLOYED_ENVS must contain "qa" — dropping it reopens MONEY-288',
    );
    assert.ok((DEPLOYED_ENVS as readonly string[]).includes("production"));
  });

  it("cannot be disabled on a deployed env by an env var", () => {
    // An operator setting the local-dev opt-out on prod must not open the gate.
    for (const v of ["true", "TRUE", "1", "yes", undefined]) {
      assert.equal(
        shouldSkipHttpOidc({ nodeEnv: "production", enablePullSubscriber: v }),
        false,
      );
    }
  });

  it("skips ONLY in local dev with the pull subscriber active", () => {
    assert.equal(
      shouldSkipHttpOidc({
        nodeEnv: "development",
        enablePullSubscriber: "true",
      }),
      true,
    );
  });

  it("does not skip in local dev without the pull subscriber", () => {
    // Pub/Sub cannot reach localhost, so there is no legitimate reason to be
    // accepting unauthenticated HTTP either.
    for (const v of [undefined, "", "false", "1", "TRUE"]) {
      assert.equal(
        shouldSkipHttpOidc({ nodeEnv: "development", enablePullSubscriber: v }),
        false,
        `ENABLE_PULL_SUBSCRIBER=${String(v)} must not open the gate`,
      );
    }
  });

  it("does not skip when NODE_ENV is unset", () => {
    // An unset NODE_ENV is not a deployed env, but it is also not proof of
    // local dev — only the explicit pull-subscriber opt-out is.
    assert.equal(
      shouldSkipHttpOidc({
        nodeEnv: undefined,
        enablePullSubscriber: undefined,
      }),
      false,
    );
  });
});

describe("the gate is actually WIRED into the app", () => {
  const src = readRepoFile("workers", "src", "index.ts");

  it("found index.ts", () => {
    assert.ok(src.length > 0, "could not read workers/src/index.ts");
  });

  // What a SCAN is still the right tool for: the factory could be perfect and
  // simply never mounted. Everything ABOUT its behaviour is now covered by
  // executing it (see the suite below), because a scan could not tell the
  // difference between `if (!skipHttpOidc)` and `if (false)`.
  it("mounts the tested middleware on /jobs/*", () => {
    assert.match(
      src,
      /app\.use\(\s*["']\/jobs\/\*["']/,
      "the job routes must be behind the gate",
    );
    assert.match(
      src,
      /createJobsAuthMiddleware\(/,
      "index.ts must build the gate from the tested factory — an inline " +
        "re-implementation is how this test came to assert a copy of the " +
        "middleware instead of the middleware",
    );
  });

  it("feeds the factory the REAL environment and verifier", () => {
    // The factory is only as good as what it is handed. Passing a literal, or
    // omitting the audience, would make every behavioural test below vacuous
    // with respect to production.
    assert.match(src, /nodeEnv:\s*process\.env\.NODE_ENV/);
    assert.match(
      src,
      /enablePullSubscriber:\s*process\.env\.ENABLE_PULL_SUBSCRIBER/,
    );
    assert.match(src, /audience:\s*process\.env\.CLOUD_RUN_URL/);
    assert.match(src, /verifyIdToken:.*oidcClient\.verifyIdToken/s);
  });

  it("does not keep a second, inline copy of the gate", () => {
    // The original defect: a test that re-declared the middleware inline, so a
    // fail-open regression in the real one could not turn it red.
    assert.doesNotMatch(
      src,
      /Unauthorized: missing token/,
      "the 401 path belongs in index-auth-logic.ts, where it is executed by " +
        "tests — a copy here would drift",
    );
  });
});

describe("an UNRECOGNISED environment must fail closed", () => {
  // The predicate used to be an ALLOW-LIST of deployed envs: "is this
  // production|qa? if not, honour the pull-subscriber opt-out". So any deployed
  // service whose NODE_ENV was neither — unset, "staging", a typo, or a Cloud
  // Build substitution that did not expand — plus ENABLE_PULL_SUBSCRIBER=true
  // skipped OIDC on every /jobs/* route. cloudbuild.yaml sets NODE_ENV from a
  // substitution matched against that hard-coded list, so "unrecognised" is a
  // realistic state. MONEY-288 was this exact class.
  it("does not skip for an env it does not recognise", () => {
    for (const nodeEnv of ["staging", "prod", "PRODUCTION", "", undefined]) {
      assert.equal(
        shouldSkipHttpOidc({ nodeEnv, enablePullSubscriber: "true" }),
        false,
        `NODE_ENV=${String(nodeEnv)} must still require a token`,
      );
    }
  });

  it("skips ONLY for an explicitly local env, with the subscriber active", () => {
    for (const nodeEnv of LOCAL_ENVS) {
      assert.equal(
        shouldSkipHttpOidc({ nodeEnv, enablePullSubscriber: "true" }),
        true,
      );
      assert.equal(
        shouldSkipHttpOidc({ nodeEnv, enablePullSubscriber: undefined }),
        false,
        "the pull subscriber must be explicitly on",
      );
    }
  });

  it("keeps the deployed envs out of the local set", () => {
    for (const d of DEPLOYED_ENVS) {
      assert.ok(
        !(LOCAL_ENVS as readonly string[]).includes(d),
        `${d} must never be treated as local`,
      );
    }
  });
});

// ── The middleware, executed ─────────────────────────────────────────────

describe("createJobsAuthMiddleware — the gate, actually run", () => {
  /**
   * These tests exist because everything above them was defeatable.
   *
   * `shouldSkipHttpOidc` was already extracted and unit tested, and the gate was
   * still trivially bypassable at the CALL SITE: appending
   * `|| process.env.ENABLE_PULL_SUBSCRIBER === "true"` to the composed
   * expression, or changing `if (!skipHttpOidc)` to `if (false)`, left the whole
   * workers suite green at exit 0 while OIDC stopped running on all ~43
   * `/jobs/*` routes. Every string the source scan looked for was still present.
   *
   * So: drive the real middleware with a fake context and assert on what it
   * RETURNS. No server, no sockets.
   */
  function ctx(authorization?: string) {
    const calls: Array<{ body: unknown; status: number }> = [];
    return {
      calls,
      c: {
        req: {
          header: (name: string) =>
            name === "Authorization" ? authorization : undefined,
        },
        json: (body: unknown, status: number) => {
          calls.push({ body, status });
          return { body, status };
        },
      },
    };
  }

  const PROD = {
    nodeEnv: "production",
    enablePullSubscriber: undefined,
    audience: "https://worker.example",
    verifyIdToken: async () => ({}),
  };

  it("rejects a request with NO token on a deployed env", async () => {
    const { c, calls } = ctx();
    let nexted = false;
    const mw = createJobsAuthMiddleware(PROD);
    await mw(c, async () => {
      nexted = true;
    });
    assert.equal(nexted, false, "must not reach the handler");
    assert.equal(calls[0]?.status, 401);
  });

  it("rejects a token the verifier refuses", async () => {
    const { c, calls } = ctx("Bearer bad");
    let nexted = false;
    const mw = createJobsAuthMiddleware({
      ...PROD,
      verifyIdToken: async () => {
        throw new Error("bad signature");
      },
    });
    await mw(c, async () => {
      nexted = true;
    });
    assert.equal(nexted, false);
    assert.equal(calls[0]?.status, 401);
  });

  it("passes a valid token through to the handler", async () => {
    // The positive half. Without it, a middleware that rejected EVERYTHING would
    // satisfy every assertion above.
    const { c, calls } = ctx("Bearer good");
    let nexted = false;
    const mw = createJobsAuthMiddleware(PROD);
    await mw(c, async () => {
      nexted = true;
    });
    assert.equal(nexted, true, "a valid token must reach the handler");
    assert.equal(calls.length, 0, "no error response");
  });

  it("verifies against the CONFIGURED audience, and 500s without one", async () => {
    // Verifying with an undefined audience would accept any Google-signed token,
    // including one minted for an unrelated service.
    let seen: { idToken: string; audience: string } | null = null;
    const ok = ctx("Bearer good");
    await createJobsAuthMiddleware({
      ...PROD,
      verifyIdToken: async (args) => {
        seen = args;
        return {};
      },
    })(ok.c, async () => {});
    assert.equal(seen!.audience, "https://worker.example");
    assert.equal(seen!.idToken, "good");

    const missing = ctx("Bearer good");
    await createJobsAuthMiddleware({ ...PROD, audience: undefined })(
      missing.c,
      async () => {},
    );
    assert.equal(missing.calls[0]?.status, 500);
  });

  it("CANNOT be disabled on a deployed env by ENABLE_PULL_SUBSCRIBER", async () => {
    // Defeat #1, executed. An operator setting this on a QA or prod service must
    // not turn HTTP auth off.
    for (const nodeEnv of ["production", "qa"]) {
      const { c, calls } = ctx();
      let nexted = false;
      await createJobsAuthMiddleware({
        ...PROD,
        nodeEnv,
        enablePullSubscriber: "true",
      })(c, async () => {
        nexted = true;
      });
      assert.equal(nexted, false, `${nodeEnv} must still require a token`);
      assert.equal(calls[0]?.status, 401, nodeEnv);
    }
  });

  it("requires a token on an UNRECOGNISED env, even with the subscriber on", async () => {
    // Fails CLOSED. `cloudbuild.yaml` sets NODE_ENV from a build substitution,
    // so unset / "staging" / a typo / an unexpanded substitution are all
    // realistic — and MONEY-288 was exactly this: verification gated on
    // `NODE_ENV === "production"` left QA wide open.
    for (const nodeEnv of [undefined, "", "staging", "prod", "Production "]) {
      const { c, calls } = ctx();
      let nexted = false;
      await createJobsAuthMiddleware({
        ...PROD,
        nodeEnv,
        enablePullSubscriber: "true",
      })(c, async () => {
        nexted = true;
      });
      assert.equal(
        nexted,
        false,
        `${JSON.stringify(nodeEnv)} must fail closed`,
      );
      assert.equal(calls[0]?.status, 401, JSON.stringify(nodeEnv));
    }
  });

  it("skips ONLY in a known-local env with the pull subscriber on", async () => {
    // The one legitimate opt-out: Pub/Sub cannot reach localhost, so jobs arrive
    // via the pull subscriber and there is no HTTP auth context to check.
    for (const nodeEnv of ["development", "test", "local"]) {
      const { c, calls } = ctx();
      let nexted = false;
      await createJobsAuthMiddleware({
        ...PROD,
        nodeEnv,
        enablePullSubscriber: "true",
      })(c, async () => {
        nexted = true;
      });
      assert.equal(nexted, true, `${nodeEnv} + subscriber should skip`);
      assert.equal(calls.length, 0);
    }
  });

  it("does NOT skip in local dev when the pull subscriber is off", async () => {
    // Both conditions are required; local alone is not enough.
    const { c, calls } = ctx();
    let nexted = false;
    await createJobsAuthMiddleware({
      ...PROD,
      nodeEnv: "development",
      enablePullSubscriber: undefined,
    })(c, async () => {
      nexted = true;
    });
    assert.equal(nexted, false);
    assert.equal(calls[0]?.status, 401);
  });
});
