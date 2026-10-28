import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * MONEY-490 / MONEY-673 (P3): the module-level citation hover/scroll-sync
 * store behind components/chat/CitationContext.tsx (setHotCitation + the
 * useSyncExternalStore-backed useCitationState).
 *
 * The store's subscribe/getSnapshot are module-private, so the only pure way
 * to reach them (no React rendering) is to stub React.useSyncExternalStore
 * with a pass-through that captures its (subscribe, getSnapshot) arguments
 * and returns the snapshot. `react` resolves to the same module instance for
 * this test and the component, so calling the real exported useCitationState()
 * hits the stub and hands us the store internals. No DOM, network, or timers.
 *
 * Tests share the module-level store state on purpose (it IS module-level
 * state); they run in declaration order and each documents the state it
 * inherits.
 */

interface CitationSnapshot {
  hot: number | null;
  scrollKey: number;
}

const requireFromWeb = createRequire(path.join(process.cwd(), "package.json"));
const reactExports = requireFromWeb("react") as Record<string, unknown>;

const captured: {
  subscribe?: (cb: () => void) => () => void;
  getSnapshot?: () => CitationSnapshot;
} = {};

// Patch BEFORE the module under test is imported (first test imports it
// dynamically), so the capture works regardless of module interop mode.
reactExports.useSyncExternalStore = (
  subscribe: (cb: () => void) => () => void,
  getSnapshot: () => CitationSnapshot
): CitationSnapshot => {
  captured.subscribe = subscribe;
  captured.getSnapshot = getSnapshot;
  return getSnapshot();
};

let store!: typeof import("../../components/chat/CitationContext");

function snap(): CitationSnapshot {
  assert.ok(captured.getSnapshot, "store getSnapshot not captured yet");
  return captured.getSnapshot();
}

function listen(cb: () => void): () => void {
  assert.ok(captured.subscribe, "store subscribe not captured yet");
  return captured.subscribe(cb);
}

test("initial snapshot is { hot: null, scrollKey: 0 } and referentially stable", async () => {
  store = await import("../../components/chat/CitationContext");

  const first = store.useCitationState();
  assert.deepEqual(first, { hot: null, scrollKey: 0 });
  assert.equal(typeof captured.subscribe, "function");
  assert.equal(typeof captured.getSnapshot, "function");

  // getSnapshot returns the SAME object until the next mutation (required for
  // useSyncExternalStore's Object.is change detection to be quiet).
  assert.equal(snap(), first);
  assert.equal(store.useCitationState(), first);
});

test("setHotCitation(n) sets hot, keeps scrollKey, and an idempotent repeat does not notify", () => {
  let notifications = 0;
  const unsubscribe = listen(() => notifications++);
  try {
    store.setHotCitation(7);
    assert.equal(notifications, 1);
    const afterFirst = snap();
    assert.deepEqual(afterFirst, { hot: 7, scrollKey: 0 });

    // Same n without scroll → early return: no emit, same state object.
    store.setHotCitation(7);
    assert.equal(notifications, 1);
    assert.equal(snap(), afterFirst);

    // A different n notifies again, still leaving scrollKey untouched, and
    // replaces the state object (immutable update).
    store.setHotCitation(3);
    assert.equal(notifications, 2);
    assert.deepEqual(snap(), { hot: 3, scrollKey: 0 });
    assert.notEqual(snap(), afterFirst);
  } finally {
    unsubscribe();
  }
});

test("setHotCitation(n, true) bumps scrollKey — even when hot is unchanged", () => {
  let notifications = 0;
  const unsubscribe = listen(() => notifications++);
  try {
    // Inherited state: { hot: 3, scrollKey: 0 }.
    assert.deepEqual(snap(), { hot: 3, scrollKey: 0 });

    // scroll=true bypasses the same-hot early return → click-scroll re-fires.
    store.setHotCitation(3, true);
    assert.equal(notifications, 1);
    assert.deepEqual(snap(), { hot: 3, scrollKey: 1 });

    store.setHotCitation(5, true);
    assert.equal(notifications, 2);
    assert.deepEqual(snap(), { hot: 5, scrollKey: 2 });
  } finally {
    unsubscribe();
  }
});

test("setHotCitation(null, true) clears hot but never bumps scrollKey", () => {
  let notifications = 0;
  const unsubscribe = listen(() => notifications++);
  try {
    // Inherited state: { hot: 5, scrollKey: 2 }.
    store.setHotCitation(null, true);
    assert.equal(notifications, 1);
    assert.deepEqual(snap(), { hot: null, scrollKey: 2 });

    // Current-behavior quirk: null→null WITH scroll=true bypasses the
    // idempotence guard, so it emits a fresh equal-valued state object
    // (subscribers are re-notified with no value change).
    const before = snap();
    store.setHotCitation(null, true);
    assert.equal(notifications, 2);
    assert.notEqual(snap(), before);
    assert.deepEqual(snap(), { hot: null, scrollKey: 2 });

    // ...while null→null WITHOUT scroll stays a silent no-op.
    store.setHotCitation(null);
    assert.equal(notifications, 2);
  } finally {
    unsubscribe();
  }
});

test("subscribe returns an unsubscribe that stops notifications (and is double-call safe)", () => {
  let a = 0;
  let b = 0;
  const unsubA = listen(() => a++);
  const unsubB = listen(() => b++);

  // Inherited state: { hot: null, scrollKey: 2 }.
  store.setHotCitation(9);
  assert.equal(a, 1);
  assert.equal(b, 1);

  unsubA();
  store.setHotCitation(10);
  assert.equal(a, 1); // A no longer notified
  assert.equal(b, 2);

  unsubA(); // double-unsubscribe is a safe no-op (Set semantics)
  unsubB();
  store.setHotCitation(null);
  assert.equal(a, 1);
  assert.equal(b, 2);
});
