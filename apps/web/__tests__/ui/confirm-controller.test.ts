/**
 * Confirm controller — the promise bookkeeping behind `usePfConfirm`
 * (MONEY-764: styled replacement for `window.confirm`).
 *
 * The hook itself is a thin React bridge (can't render here — no jsdom);
 * the CONTRACT lives in this pure module and is pinned exhaustively:
 * request resolves on settle, dismiss == cancel, a newer request cancels
 * the older one instead of hanging its awaiter, double-settle is a no-op,
 * and the onChange bridge always fires null-before-resolve so the dialog
 * unmounts before the caller's continuation runs.
 *
 * Source: apps/web/components/ui/confirm-controller.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createConfirmController,
  type ConfirmOptions,
} from "@/components/ui/confirm-controller";

const OPTS: ConfirmOptions = {
  title: "Delete?",
  description: "Gone for good.",
  variant: "destructive",
};

describe("createConfirmController", () => {
  it("request → settle(true) resolves true and clears pending", async () => {
    const c = createConfirmController();
    const p = c.request(OPTS);
    assert.deepEqual(c.pending(), OPTS);
    c.settle(true);
    assert.equal(await p, true);
    assert.equal(c.pending(), null);
  });

  it("request → settle(false) resolves false (cancel & dismiss path)", async () => {
    const c = createConfirmController();
    const p = c.request(OPTS);
    c.settle(false);
    assert.equal(await p, false);
    assert.equal(c.pending(), null);
  });

  it("a second request cancels the first (resolves false, never hangs)", async () => {
    const c = createConfirmController();
    const first = c.request(OPTS);
    const second = c.request({ ...OPTS, title: "Second" });
    assert.equal(await first, false);
    assert.equal(c.pending()?.title, "Second");
    c.settle(true);
    assert.equal(await second, true);
  });

  it("settle with nothing pending is a no-op", () => {
    const c = createConfirmController();
    assert.doesNotThrow(() => c.settle(true));
    assert.doesNotThrow(() => c.settle(false));
    assert.equal(c.pending(), null);
  });

  it("double-settle resolves once with the FIRST answer", async () => {
    const c = createConfirmController();
    const p = c.request(OPTS);
    c.settle(true);
    c.settle(false); // Radix fires onOpenChange(false) after the action click
    assert.equal(await p, true);
  });

  it("notifies onChange with options on request and null on settle", () => {
    const seen: Array<ConfirmOptions | null> = [];
    const c = createConfirmController((p) => seen.push(p));
    c.request(OPTS);
    c.settle(true);
    assert.deepEqual(seen, [OPTS, null]);
  });

  it("onChange sees null BEFORE the awaiter resumes (dialog closes first)", async () => {
    const order: string[] = [];
    const c = createConfirmController((p) => {
      order.push(p === null ? "closed" : "opened");
    });
    const p = c.request(OPTS).then((ok) => {
      order.push(`resolved:${ok}`);
    });
    c.settle(true);
    await p;
    assert.deepEqual(order, ["opened", "closed", "resolved:true"]);
  });

  it("a replaced request notifies close+reopen in order", () => {
    const order: string[] = [];
    const c = createConfirmController((p) =>
      order.push(p === null ? "null" : p.title)
    );
    c.request({ ...OPTS, title: "A" });
    c.request({ ...OPTS, title: "B" });
    assert.deepEqual(order, ["A", "null", "B"]);
  });
});
