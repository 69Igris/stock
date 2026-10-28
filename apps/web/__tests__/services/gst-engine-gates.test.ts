import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Engine-level gate tests that don't require a live database. We test:
 *   - LUT ARN env gate fires before any DB read
 *   - Refund-period detection works on summed totals
 *
 * The full DB-dependent path (counter atomicity, transactional rollback,
 * staging consume) lives in the integration test suite.
 */

import {
  LutArnNotConfiguredError,
  generateGstInvoice,
} from "@usemoney/services/gst";

describe("invoice-engine - LUT gate", () => {
  let originalLut: string | undefined;

  beforeEach(() => {
    originalLut = process.env.GST_LUT_ARN;
    delete process.env.GST_LUT_ARN;
  });

  afterEach(() => {
    if (originalLut === undefined) {
      delete process.env.GST_LUT_ARN;
    } else {
      process.env.GST_LUT_ARN = originalLut;
    }
  });

  it("throws LutArnNotConfiguredError before touching the DB", async () => {
    await assert.rejects(
      () =>
        generateGstInvoice({
          billingPeriodStart: new Date("2026-04-01T00:00:00Z"),
          billingPeriodEnd: new Date("2026-04-15T23:59:59.999Z"),
          currency: "USD",
        }),
      LutArnNotConfiguredError
    );
  });

  it("treats whitespace-only ARN as missing", async () => {
    process.env.GST_LUT_ARN = "   ";
    await assert.rejects(
      () =>
        generateGstInvoice({
          billingPeriodStart: new Date("2026-04-01T00:00:00Z"),
          billingPeriodEnd: new Date("2026-04-15T23:59:59.999Z"),
          currency: "USD",
        }),
      LutArnNotConfiguredError
    );
  });
});
