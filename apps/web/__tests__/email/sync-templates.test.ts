/**
 * MONEY-848: broker sync email TEMPLATES — real components rendered to HTML.
 *
 * Pins the rendered-output behaviours the worker + actions rely on:
 *   - HistoricalSyncCompleteEmail: a NON-empty backfill renders the
 *     "Historical Import Complete" + "N historical trades" copy; an EMPTY
 *     backfill (tradesCount <= 0) renders the graceful "Connected & Synced"
 *     variant instead of a confusing "0 historical trades".
 *   - SyncCompleteEmail: per-type counts render; and a mutualFundsError renders
 *     the "re-authorise" note rather than a misleading "Mutual Funds: 0".
 *
 * Renders the REAL components from `@usemoney/email/templates` via
 * `@react-email/render` (no shadow copies).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";

type Render = (
  el: React.ReactElement,
  opts?: { plainText?: boolean }
) => Promise<string>;

let render: Render;
let HistoricalSyncCompleteEmail: (p: {
  name: string;
  brokerName: string;
  tradesCount: number;
  brokerUserId?: string;
  accountName?: string;
}) => React.ReactElement;
let SyncCompleteEmail: (p: {
  name: string;
  brokerName: string;
  holdingsCount: number;
  positionsCount: number;
  tradesCount: number;
  mutualFundsCount?: number;
  mutualFundsError?: boolean;
}) => React.ReactElement;

before(async () => {
  const renderMod = await import("@react-email/render");
  render = renderMod.render as Render;
  const templates = await import("@usemoney/email/templates");
  HistoricalSyncCompleteEmail =
    templates.HistoricalSyncCompleteEmail as typeof HistoricalSyncCompleteEmail;
  SyncCompleteEmail = templates.SyncCompleteEmail as typeof SyncCompleteEmail;
});

describe("HistoricalSyncCompleteEmail (MONEY-848 graceful empty)", () => {
  it("non-empty backfill → 'Historical Import Complete' + the trade count", async () => {
    const html = await render(
      React.createElement(HistoricalSyncCompleteEmail, {
        name: "Asha",
        brokerName: "Zerodha",
        tradesCount: 8553,
      }),
      { plainText: true }
    );
    // The plainText renderer upper-cases the <Heading> + hard-wraps lines, so
    // match case-insensitively and tolerate a newline between the number + word.
    assert.match(html, /Historical Import Complete/i);
    assert.match(html, /8553\s+historical trade/i);
    assert.doesNotMatch(html, /Connected & Synced/i);
  });

  it("singular trade reads 'trade' (not 'trades')", async () => {
    const html = await render(
      React.createElement(HistoricalSyncCompleteEmail, {
        name: "Asha",
        brokerName: "Zerodha",
        tradesCount: 1,
      }),
      { plainText: true }
    );
    // tolerate the hard line-wrap between "1" and "historical trade"
    assert.match(html, /\b1\s+historical trade\b/);
    assert.doesNotMatch(html, /\b1\s+historical trades\b/);
  });

  it("EMPTY backfill (0 trades) → graceful 'Connected & Synced', no '0 trades'", async () => {
    const html = await render(
      React.createElement(HistoricalSyncCompleteEmail, {
        name: "Asha",
        brokerName: "Zerodha",
        tradesCount: 0,
      }),
      { plainText: true }
    );
    assert.match(html, /Connected & Synced/i);
    assert.match(html, /connected and fully\s+synced/i);
    // never the confusing empty-history phrasing
    assert.doesNotMatch(html, /0 historical trade/i);
    assert.doesNotMatch(html, /Historical Import Complete/i);
  });
});

describe("SyncCompleteEmail (MONEY-848 manual-sync summary)", () => {
  it("renders per-type counts", async () => {
    const html = await render(
      React.createElement(SyncCompleteEmail, {
        name: "Asha",
        brokerName: "Zerodha",
        holdingsCount: 12,
        positionsCount: 3,
        tradesCount: 40,
        mutualFundsCount: 5,
      }),
      { plainText: true }
    );
    // MONEY-878: counts now render in the mono stat strip (label then value on
    // separate lines in the plainText render) rather than "Label: value" rows.
    assert.match(html, /Holdings\s+12/);
    assert.match(html, /Positions\s+3/);
    assert.match(html, /Trades\s+40/);
    assert.match(html, /Mutual funds\s+5/);
  });

  it("mutualFundsError → 're-authorise' note, not a misleading 'Mutual Funds: 0'", async () => {
    const html = await render(
      React.createElement(SyncCompleteEmail, {
        name: "Asha",
        brokerName: "Zerodha",
        holdingsCount: 12,
        positionsCount: 3,
        tradesCount: 40,
        mutualFundsCount: 0,
        mutualFundsError: true,
      }),
      { plainText: true }
    );
    // tolerate the plainText hard-wrap between "mutual-fund" and "sync"
    assert.match(html, /re-authorise the broker to enable mutual-fund\s+sync/i);
    assert.doesNotMatch(html, /Mutual Funds: 0/);
  });
});
