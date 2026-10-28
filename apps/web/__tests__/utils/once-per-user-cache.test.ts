/**
 * MONEY-1126 — the resolve-once seam behind `SessionGuard` and `TermsGate`.
 *
 * Both guards keyed their server call on `pathname`, so a ghosted-session check
 * and a terms-acceptance check fired on EVERY client-side navigation. This cache
 * makes them resolve once per page load. Because it now sits in front of a
 * security gate and a compliance gate, the properties asserted here are the
 * whole safety argument:
 *
 *   - only answers the caller declares safe are remembered;
 *   - a rejection is NEVER remembered, so a blip cannot pin a decision;
 *   - the slot is keyed by user id and holds exactly one entry, so a second
 *     account on the same browser structurally cannot read the first one's
 *     answer.
 *
 * `__tests__/components/guards-wiring.test.ts` pins the predicates the two
 * guards pass in; together the two files prove "the gate got quieter, not more
 * permissive".
 *
 * Source: apps/web/lib/utils/once-per-user-cache.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createOncePerUserCache,
  type OncePerUserCache,
} from "@/lib/utils/once-per-user-cache";

const USER_A = "user_2abcABC";
const USER_B = "user_2xyzXYZ";

/** A resolver that counts its invocations, like a server action would be hit. */
function counted<T>(impl: () => Promise<T>): {
  resolve: () => Promise<T>;
  calls: () => number;
} {
  let calls = 0;
  return {
    resolve: () => {
      calls += 1;
      return impl();
    },
    calls: () => calls,
  };
}

// ── Terms-shaped cache: remember only "accepted" ────────────────────────────

describe("once-per-user cache: reuse", () => {
  let cache: OncePerUserCache<boolean>;

  beforeEach(() => {
    cache = createOncePerUserCache<boolean>({
      shouldRemember: (accepted) => accepted === true,
    });
  });

  it("[regression] asks once across many navigations", async () => {
    const server = counted(async () => true);

    for (let navigation = 0; navigation < 8; navigation += 1) {
      assert.equal(await cache.get(USER_A, server.resolve), true);
    }

    assert.equal(server.calls(), 1, "8 navigations, 1 server call");
  });

  it("shares a single in-flight request between concurrent callers", async () => {
    let release: (value: boolean) => void = () => {};
    const server = counted(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );

    const inflight = [
      cache.get(USER_A, server.resolve),
      cache.get(USER_A, server.resolve),
      cache.get(USER_A, server.resolve),
    ];
    assert.equal(server.calls(), 1);

    release(true);
    assert.deepEqual(await Promise.all(inflight), [true, true, true]);
    assert.equal(server.calls(), 1);
  });

  it("peek is undefined until an answer is accepted, then synchronous", async () => {
    const server = counted(async () => true);

    assert.equal(cache.peek(USER_A), undefined);
    await cache.get(USER_A, server.resolve);
    assert.equal(cache.peek(USER_A), true);
  });

  it("clear() drops the answer so the next call re-asks", async () => {
    const server = counted(async () => true);

    await cache.get(USER_A, server.resolve);
    cache.clear();
    assert.equal(cache.peek(USER_A), undefined);

    await cache.get(USER_A, server.resolve);
    assert.equal(server.calls(), 2);
  });
});

describe("once-per-user cache: the gate cannot get more permissive", () => {
  let cache: OncePerUserCache<boolean>;

  beforeEach(() => {
    cache = createOncePerUserCache<boolean>({
      shouldRemember: (accepted) => accepted === true,
    });
  });

  it("[security] a BLOCKING answer is never remembered — it is re-asked every time", async () => {
    const server = counted(async () => false); // terms NOT accepted

    for (let navigation = 0; navigation < 5; navigation += 1) {
      assert.equal(await cache.get(USER_A, server.resolve), false);
    }

    assert.equal(
      server.calls(),
      5,
      "the blocked user is re-checked on every navigation, exactly as before"
    );
    assert.equal(cache.peek(USER_A), undefined);
  });

  it("[security] a rejection is never remembered and propagates to the caller", async () => {
    const server = counted<boolean>(async () => {
      throw new Error("network down");
    });

    await assert.rejects(
      () => cache.get(USER_A, server.resolve),
      /network down/
    );
    assert.equal(cache.peek(USER_A), undefined, "no answer was recorded");

    await assert.rejects(
      () => cache.get(USER_A, server.resolve),
      /network down/
    );
    assert.equal(server.calls(), 2, "the next navigation retries");
  });

  it("[security] a failure followed by a real answer yields the real answer", async () => {
    let attempt = 0;
    const server = counted<boolean>(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("blip");
      return true;
    });

    await assert.rejects(() => cache.get(USER_A, server.resolve), /blip/);
    assert.equal(await cache.get(USER_A, server.resolve), true);
    assert.equal(cache.peek(USER_A), true);
  });

  it("[security] a later BLOCKING answer is not masked by an earlier accepted one for a DIFFERENT user", async () => {
    await cache.get(USER_A, async () => true);

    const server = counted(async () => false);
    assert.equal(await cache.get(USER_B, server.resolve), false);
    assert.equal(server.calls(), 1);
    assert.equal(cache.peek(USER_B), undefined);
  });
});

describe("once-per-user cache: user isolation", () => {
  it("[security] never serves one user's answer to another", async () => {
    const cache = createOncePerUserCache<string>({
      shouldRemember: () => true,
    });

    await cache.get(USER_A, async () => "A-answer");

    assert.equal(cache.peek(USER_A), "A-answer");
    assert.equal(cache.peek(USER_B), undefined, "different id ⇒ miss");

    const server = counted(async () => "B-answer");
    assert.equal(await cache.get(USER_B, server.resolve), "B-answer");
    assert.equal(
      server.calls(),
      1,
      "B is resolved from the server, not the slot"
    );
  });

  it("holds a single slot — a new user evicts the previous one", async () => {
    const cache = createOncePerUserCache<string>({
      shouldRemember: () => true,
    });

    await cache.get(USER_A, async () => "A-answer");
    await cache.get(USER_B, async () => "B-answer");

    assert.equal(cache.peek(USER_B), "B-answer");
    assert.equal(
      cache.peek(USER_A),
      undefined,
      "bounded: it cannot accumulate entries across sign-ins"
    );
  });

  it("an in-flight request for one user does not satisfy another", async () => {
    const cache = createOncePerUserCache<string>({
      shouldRemember: () => true,
    });

    let releaseA: (v: string) => void = () => {};
    const a = cache.get(
      USER_A,
      () => new Promise<string>((resolve) => (releaseA = resolve))
    );

    const bServer = counted(async () => "B-answer");
    const b = cache.get(USER_B, bServer.resolve);

    releaseA("A-answer");
    assert.equal(await a, "A-answer");
    assert.equal(await b, "B-answer");
    assert.equal(bServer.calls(), 1);
  });
});

// ── SessionGuard-shaped cache: remember only "not ghosted" ──────────────────

describe("once-per-user cache: ghosted-session shape", () => {
  it("[security] a GHOSTED answer is never remembered", async () => {
    const cache = createOncePerUserCache<boolean>({
      shouldRemember: (ghosted) => ghosted === false,
    });

    const server = counted(async () => true); // ghosted

    assert.equal(await cache.get(USER_A, server.resolve), true);
    assert.equal(cache.peek(USER_A), undefined);

    assert.equal(await cache.get(USER_A, server.resolve), true);
    assert.equal(server.calls(), 2, "still re-checked; sign-out is not cached");
  });

  it("a HEALTHY answer is remembered, so navigation stops re-asking", async () => {
    const cache = createOncePerUserCache<boolean>({
      shouldRemember: (ghosted) => ghosted === false,
    });

    const server = counted(async () => false);

    for (let navigation = 0; navigation < 6; navigation += 1) {
      assert.equal(await cache.get(USER_A, server.resolve), false);
    }

    assert.equal(server.calls(), 1);
    assert.equal(cache.peek(USER_A), false);
  });
});
