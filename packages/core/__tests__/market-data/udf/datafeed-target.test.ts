/**
 * Which origin the chart talks to — MONEY-1468 (A3).
 *
 * The two failure directions are NOT symmetric, which is the whole design:
 *
 *   fail to the OLD route   a slower chart, correct data, nobody notices
 *   fail to the NEW route   before tiles exist, every symbol answers no_data
 *                           and the chart is BLANK with no error
 *
 * So every ambiguous input must resolve to the legacy route.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_UDF_BASE_URL,
  MARKET_DATA_TILES_FLAG,
  isTilesFlagEnabled,
  resolveUdfBaseUrl,
} from "../../../src/market-data/udf/datafeed-target";

const URL_OK = "https://market-data-qa.usemoney.ai";

describe("the flag is read literally, never coerced", () => {
  it("only an explicit true is true", () => {
    assert.equal(isTilesFlagEnabled(true), true);
    assert.equal(isTilesFlagEnabled("true"), true);
    assert.equal(isTilesFlagEnabled("TRUE"), true);
    assert.equal(isTilesFlagEnabled({ enabled: true }), true);
  });

  it('the string "false" is FALSE', () => {
    // `Boolean("false")` is true, which would arm the one configuration meant
    // to keep it off — the same trap the *_APPLY env flags document.
    assert.equal(isTilesFlagEnabled("false"), false);
    assert.equal(isTilesFlagEnabled({ enabled: "false" }), false);
  });

  it("absent, null and junk are all false", () => {
    for (const v of [
      undefined,
      null,
      0,
      1,
      "",
      "yes",
      {},
      [],
      { enabled: 1 },
    ]) {
      assert.equal(
        isTilesFlagEnabled(v),
        false,
        `${JSON.stringify(v)} must not enable it`,
      );
    }
  });
});

describe("the base URL fails SAFE", () => {
  it("flag on + a good https origin gives the service", () => {
    assert.equal(
      resolveUdfBaseUrl({ flagValue: true, marketDataUrl: URL_OK }),
      "https://market-data-qa.usemoney.ai/udf",
    );
  });

  it("a trailing path or slash is normalised to the origin", () => {
    // Otherwise the datafeed builds `https://host/udf/udf/history`.
    assert.equal(
      resolveUdfBaseUrl({
        flagValue: true,
        marketDataUrl: "https://market-data-qa.usemoney.ai/",
      }),
      "https://market-data-qa.usemoney.ai/udf",
    );
  });

  it("flag OFF always gives the legacy route, whatever the URL", () => {
    assert.equal(
      resolveUdfBaseUrl({ flagValue: false, marketDataUrl: URL_OK }),
      LEGACY_UDF_BASE_URL,
    );
    assert.equal(
      resolveUdfBaseUrl({ marketDataUrl: URL_OK }),
      LEGACY_UDF_BASE_URL,
    );
  });

  it("flag ON but the URL is missing or malformed gives the LEGACY route", () => {
    // The dangerous direction. Pointing the chart at a broken origin renders
    // as a blank chart, not an error.
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "not a url",
      "/relative/path",
    ]) {
      assert.equal(
        resolveUdfBaseUrl({ flagValue: true, marketDataUrl: bad }),
        LEGACY_UDF_BASE_URL,
        `${JSON.stringify(bad)} must fall back`,
      );
    }
  });

  it("http is REFUSED — the A5 token must not cross plaintext", () => {
    assert.equal(
      resolveUdfBaseUrl({
        flagValue: true,
        marketDataUrl: "http://market-data-qa.usemoney.ai",
      }),
      LEGACY_UDF_BASE_URL,
    );
  });

  it("the flag key is the one the brief names", () => {
    assert.equal(MARKET_DATA_TILES_FLAG, "MARKET_DATA_TILES");
  });
});
