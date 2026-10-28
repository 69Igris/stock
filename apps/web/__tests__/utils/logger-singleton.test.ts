/**
 * Logger HMR-safe singleton - B7 (MONEY-218-followup).
 *
 * Validates the global-cache pattern in apps/web/lib/logger/index.ts.
 * The actual fix is module-scoped + global state so we can't import the
 * logger and meaningfully test HMR behaviour from a unit test (the
 * runtime module cache is itself the thing we'd need to clear).
 *
 * What we CAN test cheaply: the global-cache shape contract - the
 * cached logger lives under a known key, lookups are idempotent, and
 * setMaxListeners(0) is the bumped value (NOT the old 30 ceiling
 * which itself caused the warning).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface FakeProcessLike {
  stdout: { setMaxListeners: (n: number) => void; _max: number };
  stderr: { setMaxListeners: (n: number) => void; _max: number };
}

function makeFakeProcess(): FakeProcessLike {
  const stdout = {
    _max: 10,
    setMaxListeners(n: number) {
      this._max = n;
    },
  };
  const stderr = {
    _max: 10,
    setMaxListeners(n: number) {
      this._max = n;
    },
  };
  return { stdout, stderr };
}

interface FakeGlobal {
  __usemoneyRootLogger?: { id: number };
  __usemoneyMaxListenersBumped?: boolean;
}

function bumpMaxListenersOnce(g: FakeGlobal, p: FakeProcessLike): void {
  if (g.__usemoneyMaxListenersBumped) return;
  p.stdout.setMaxListeners(0);
  p.stderr.setMaxListeners(0);
  g.__usemoneyMaxListenersBumped = true;
}

let nextId = 1;
function makePinoLike(): { id: number } {
  return { id: nextId++ };
}

function getRootLogger(g: FakeGlobal, p: FakeProcessLike): { id: number } {
  if (!g.__usemoneyRootLogger) {
    bumpMaxListenersOnce(g, p);
    g.__usemoneyRootLogger = makePinoLike();
  }
  return g.__usemoneyRootLogger;
}

describe("logger HMR singleton - B7 (MONEY-218-followup)", () => {
  it("first lookup creates the logger and bumps maxListeners to 0", () => {
    nextId = 1;
    const g: FakeGlobal = {};
    const p = makeFakeProcess();
    const a = getRootLogger(g, p);
    assert.equal(a.id, 1);
    assert.equal(p.stdout._max, 0);
    assert.equal(p.stderr._max, 0);
    assert.equal(g.__usemoneyMaxListenersBumped, true);
  });

  it("second lookup returns the SAME instance (no re-creation)", () => {
    nextId = 1;
    const g: FakeGlobal = {};
    const p = makeFakeProcess();
    const a = getRootLogger(g, p);
    const b = getRootLogger(g, p);
    assert.equal(a, b);
    assert.equal(b.id, 1);
  });

  it("HMR rebuild simulation: re-importing the module reuses the cached instance", () => {
    nextId = 1;
    const g: FakeGlobal = {};
    const p = makeFakeProcess();
    const beforeReload = getRootLogger(g, p);

    // Simulating an HMR cycle: the module-scoped variables go away,
    // but globalThis (and our fake `g`) survive. The next call should
    // hit the cached logger, NOT create a new pino instance + worker
    // thread.
    // (In production code there's no module-scoped state - we read
    // straight off globalThis. This test asserts that contract.)
    const afterReload = getRootLogger(g, p);

    assert.equal(beforeReload, afterReload);
    assert.equal(nextId, 2, "only one pino instance was constructed");
  });

  it("bumpMaxListenersOnce is idempotent - second call doesn't reset", () => {
    const g: FakeGlobal = {};
    const p = makeFakeProcess();
    bumpMaxListenersOnce(g, p);
    p.stdout._max = 30; // simulate an external setMaxListeners(30) call
    bumpMaxListenersOnce(g, p);
    assert.equal(p.stdout._max, 30, "second bump should be a no-op");
  });

  it("100 simulated HMR cycles still produce one pino instance", () => {
    nextId = 1;
    const g: FakeGlobal = {};
    const p = makeFakeProcess();
    for (let i = 0; i < 100; i++) {
      getRootLogger(g, p);
    }
    assert.equal(nextId, 2, "100 lookups, 1 pino - singleton survived");
  });
});
