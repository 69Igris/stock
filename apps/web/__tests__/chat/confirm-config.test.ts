/**
 * Tests for the ConfirmModal config resolver (MONEY-587, StockSage design).
 *
 * The renderer must show the right variant per tool even before a producer
 * populates the ActionBlock variant fields, and block fields must override the
 * inferred defaults.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfirmConfig,
  variantForTool,
  buildConfirmFields,
  confirmedHrefFor,
} from "../../lib/chat/confirm-config";
import type { ActionBlock } from "@usemoney/types";

function block(partial: Partial<ActionBlock>): ActionBlock {
  return {
    type: "action",
    actionId: "confirm-1",
    tool: "generic_tool",
    description: "",
    params: {},
    status: "pending",
    ...partial,
  };
}

describe("confirm-config: variantForTool", () => {
  it("maps each tool to its variant", () => {
    assert.equal(variantForTool("run_research"), "research");
    assert.equal(variantForTool("run_comprehensive_analysis"), "research");
    assert.equal(variantForTool("start_roast"), "roast");
    assert.equal(variantForTool("buy_paper_position"), "trade");
    assert.equal(variantForTool("sell_paper_position"), "trade");
    assert.equal(variantForTool("connect_broker"), "connect");
    assert.equal(variantForTool("disconnect_broker"), "danger");
    assert.equal(variantForTool("anything_else"), "generic");
  });
});

describe("confirm-config: resolveConfirmConfig (inferred from tool)", () => {
  it("roast → flame, danger accent, disclaimer, Run/Cancel", () => {
    const c = resolveConfirmConfig(block({ tool: "start_roast" }));
    assert.equal(c.variant, "roast");
    assert.equal(c.accent, "danger");
    assert.equal(c.icon, "flame");
    assert.match(c.disclaimer ?? "", /not investment advice/);
    assert.deepEqual(
      c.actions.map((a) => a.result),
      ["confirm", "cancelled"]
    );
  });

  it("paper trade → trend icon, emerald, paper disclaimer", () => {
    const c = resolveConfirmConfig(block({ tool: "buy_paper_position" }));
    assert.equal(c.variant, "trade");
    assert.equal(c.icon, "trend");
    assert.match(c.disclaimer ?? "", /Paper trading only/);
  });

  it("disconnect → danger highlight frame + solid Disconnect button", () => {
    const c = resolveConfirmConfig(block({ tool: "disconnect_broker" }));
    assert.equal(c.variant, "danger");
    assert.equal(c.frame, "highlight");
    assert.equal(c.actions[0]!.kind, "danger");
  });

  it("generic → warning highlight, Confirm/Cancel", () => {
    const c = resolveConfirmConfig(block({ tool: "something" }));
    assert.equal(c.variant, "generic");
    assert.equal(c.frame, "highlight");
    assert.equal(c.actions[0]!.label, "Confirm");
  });

  it("research with credits is promoted to the paid (deep-research) variant", () => {
    const plain = resolveConfirmConfig(block({ tool: "run_research" }));
    assert.equal(plain.variant, "research");
    const paid = resolveConfirmConfig(
      block({ tool: "run_research", credits: 3, model: "Pro + grounding" })
    );
    assert.equal(paid.variant, "paid");
    assert.equal(paid.cost?.credits, 3);
    assert.equal(paid.cost?.model, "Pro + grounding");
  });
});

describe("confirm-config: block fields override inferred defaults", () => {
  it("description overrides the title; explicit variant/accent/frame win", () => {
    const c = resolveConfirmConfig(
      block({
        tool: "start_roast",
        description: "Roast my portfolio?",
        accent: "emerald",
        frame: "highlight",
      })
    );
    assert.equal(c.title, "Roast my portfolio?");
    assert.equal(c.accent, "emerald");
    assert.equal(c.frame, "highlight");
  });

  it("order / brokers / candidates / disclaimer pass through", () => {
    const c = resolveConfirmConfig(
      block({
        tool: "buy_paper_position",
        order: {
          side: "BUY",
          symbol: "RELIANCE",
          qty: "10 shares",
          type: "Market",
          value: "≈ ₹29,185",
        },
      })
    );
    assert.equal(c.order?.symbol, "RELIANCE");
    assert.equal(c.order?.side, "BUY");

    const connect = resolveConfirmConfig(
      block({ tool: "connect_broker", brokers: ["Zerodha", "Upstox"] })
    );
    assert.deepEqual(connect.brokers, ["Zerodha", "Upstox"]);

    const disambig = resolveConfirmConfig(
      block({
        tool: "run_research",
        candidates: [{ ticker: "INFY", name: "Infosys", exchange: "NSE" }],
      })
    );
    assert.equal(disambig.candidates?.[0]?.ticker, "INFY");
  });
});

describe("confirm-config: buildConfirmFields (producer)", () => {
  it("paper buy → BUY order sub-card with computed est. value", () => {
    const f = buildConfirmFields("buy_paper_position", {
      symbol: "RELIANCE.NS",
      quantity: 10,
      price: 2918.5,
    });
    assert.equal(f.order?.side, "BUY");
    assert.equal(f.order?.symbol, "RELIANCE");
    assert.equal(f.order?.qty, "10 shares");
    assert.equal(f.order?.value, "≈ ₹29,185");
  });

  it("paper sell → SELL; singular share; no price → Market", () => {
    assert.equal(
      buildConfirmFields("sell_paper_position", {
        symbol: "TCS",
        quantity: 1,
        price: 0,
      }).order?.side,
      "SELL"
    );
    const one = buildConfirmFields("buy_paper_position", {
      symbol: "TCS",
      quantity: 1,
      price: 0,
    });
    assert.equal(one.order?.qty, "1 share");
    assert.equal(one.order?.value, "Market");
  });

  it("roast → 5 credits + eta; connect → broker chips; unknown → empty", () => {
    assert.deepEqual(buildConfirmFields("start_roast", {}), {
      credits: 5,
      eta: "~30s",
    });
    assert.deepEqual(buildConfirmFields("connect_broker", {}).brokers, [
      "Zerodha",
      "Upstox",
      "Groww",
      "Dhan",
    ]);
    assert.deepEqual(buildConfirmFields("get_holdings", {}), {});
  });

  it("invalid paper params (no symbol/qty) → empty", () => {
    assert.deepEqual(buildConfirmFields("buy_paper_position", {}), {});
  });
});

// ── MONEY-1120: the post-confirm CTA must be able to navigate ──
//
// Reported in MONEY-1095 as "Open Run button does not work". The renderer drew
// `confirmedCta` as a bare <span> with no destination, so the card showed an
// "Open run →" affordance that could never do anything. The href now decides
// whether the CTA is drawn at all.

describe("confirm-config: confirmedHrefFor (MONEY-1120)", () => {
  it("points research + paid runs at their analysis page", () => {
    assert.equal(
      confirmedHrefFor("research", "sess_123"),
      "/analysis/sess_123"
    );
    assert.equal(confirmedHrefFor("paid", "sess_123"), "/analysis/sess_123");
  });

  it("URL-encodes the session id", () => {
    assert.equal(confirmedHrefFor("research", "a/b?c"), "/analysis/a%2Fb%3Fc");
  });

  it("returns undefined for a research run with no session id yet", () => {
    // The CTA must be omitted rather than rendered as a dead element.
    assert.equal(confirmedHrefFor("research", undefined), undefined);
    assert.equal(confirmedHrefFor("paid", ""), undefined);
  });

  it("roast falls back to the index when it has no id", () => {
    assert.equal(confirmedHrefFor("roast", "r1"), "/roast/r1");
    assert.equal(confirmedHrefFor("roast", undefined), "/roast");
  });

  it("session-less variants use their static destination", () => {
    assert.equal(confirmedHrefFor("trade", undefined), "/tradebook");
    assert.equal(confirmedHrefFor("connect", undefined), "/holdings");
  });

  it("variants with no destination return undefined", () => {
    assert.equal(confirmedHrefFor("generic", "x"), undefined);
    assert.equal(confirmedHrefFor("danger", "x"), undefined);
  });

  it("resolveConfirmConfig threads the block's sessionId into the href", () => {
    const cfg = resolveConfirmConfig(
      block({ tool: "run_research", sessionId: "sess_abc" })
    );
    assert.equal(cfg.confirmedCta, "Open run");
    assert.equal(cfg.confirmedHref, "/analysis/sess_abc");
  });

  it("every variant offering a CTA can resolve a destination", () => {
    // Guards the invariant directly: a variant that advertises `confirmedCta`
    // must be able to produce an href for some input, or it will render a
    // CTA-shaped element that goes nowhere — the original bug.
    for (const tool of [
      "run_research",
      "start_roast",
      "buy_paper_position",
      "connect_broker",
    ]) {
      const cfg = resolveConfirmConfig(block({ tool, sessionId: "s1" }));
      if (cfg.confirmedCta) {
        assert.ok(
          cfg.confirmedHref,
          `${tool} advertises CTA "${cfg.confirmedCta}" but resolves no href`
        );
      }
    }
  });
});
