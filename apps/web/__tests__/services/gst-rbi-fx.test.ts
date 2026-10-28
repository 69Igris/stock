import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getRbiReferenceRate,
  RbiRateUnavailableError,
} from "@usemoney/services/gst";

const ENV_KEYS = [
  "GST_FX_RATE_USD_2026-04-30",
  "GST_FX_RATE_GBP_2026-04-30",
  "GST_FX_RATE_USD_2026-04-15",
];

function resetEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("getRbiReferenceRate", () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  it("uses ops env override when set", async () => {
    process.env["GST_FX_RATE_USD_2026-04-30"] = "83.42";
    const result = await getRbiReferenceRate({
      currency: "USD",
      invoiceDate: new Date("2026-04-30T12:00:00Z"),
    });
    assert.equal(result.currency, "USD");
    assert.equal(result.rate, 83.42);
    assert.equal(result.source, "ops_override");
    assert.equal(result.rateDate, "2026-04-30");
    assert.match(result.sourceUrl, /env:GST_FX_RATE_USD/);
  });

  it("uppercases currency and matches override key case-sensitively for date", async () => {
    process.env["GST_FX_RATE_GBP_2026-04-30"] = "104.10";
    const result = await getRbiReferenceRate({
      currency: "gbp",
      invoiceDate: new Date("2026-04-30T00:00:00Z"),
    });
    assert.equal(result.currency, "GBP");
    assert.equal(result.rate, 104.1);
  });

  it("rejects empty/zero/non-numeric env override", async () => {
    process.env["GST_FX_RATE_USD_2026-04-30"] = "abc";
    await assert.rejects(
      () =>
        getRbiReferenceRate({
          currency: "USD",
          invoiceDate: new Date("2026-04-30T00:00:00Z"),
        }),
      RbiRateUnavailableError
    );
  });

  it("rejects when neither override nor live rate is available", async () => {
    await assert.rejects(
      () =>
        getRbiReferenceRate({
          currency: "USD",
          invoiceDate: new Date("2026-04-15T00:00:00Z"),
        }),
      (err) => {
        assert.ok(err instanceof RbiRateUnavailableError);
        assert.match(
          (err as Error).message,
          /USD on 2026-04-15.*Set GST_FX_RATE_USD_2026-04-15/
        );
        return true;
      }
    );
  });
});
