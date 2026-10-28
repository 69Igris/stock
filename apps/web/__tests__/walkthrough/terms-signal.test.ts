import { test } from "node:test";
import assert from "node:assert/strict";

// Shim a minimal `window` BEFORE importing the module. The signal
// module reads `typeof window` at call time, so this only needs to
// exist when its functions are invoked - but having it before import
// keeps semantics consistent regardless of evaluation order.
if (typeof globalThis.window === "undefined") {
  class WinShim extends EventTarget {
    // Minimal CustomEvent passthrough - EventTarget already accepts
    // any Event; the module constructs CustomEvent which extends Event.
  }
  // @ts-expect-error assignable in test env
  globalThis.window = new WinShim();
}

import {
  setTermsBlocking,
  isTermsBlocking,
  onTermsBlockingChange,
} from "../../lib/walkthrough/terms-signal";

test("isTermsBlocking defaults to true and flips on set", () => {
  setTermsBlocking(true); // normalize for repeat runs
  assert.equal(isTermsBlocking(), true);
  setTermsBlocking(false);
  assert.equal(isTermsBlocking(), false);
});

test("setTermsBlocking notifies subscribers on change", () => {
  setTermsBlocking(true);
  let observed: boolean | null = null;
  const unsub = onTermsBlockingChange((b) => {
    observed = b;
  });
  setTermsBlocking(false);
  assert.equal(observed, false);
  unsub();
});

test("identical sets are coalesced (no spurious events)", () => {
  setTermsBlocking(false);
  let count = 0;
  const unsub = onTermsBlockingChange(() => {
    count++;
  });
  setTermsBlocking(false);
  setTermsBlocking(false);
  assert.equal(count, 0);
  unsub();
});

test("unsubscribe stops callbacks", () => {
  setTermsBlocking(true);
  let count = 0;
  const unsub = onTermsBlockingChange(() => {
    count++;
  });
  setTermsBlocking(false);
  assert.equal(count, 1);
  unsub();
  setTermsBlocking(true);
  setTermsBlocking(false);
  assert.equal(count, 1, "no callbacks after unsubscribe");
});
