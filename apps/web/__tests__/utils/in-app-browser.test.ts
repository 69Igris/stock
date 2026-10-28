/**
 * MONEY-393 §14 - In-app browser (WebView) UA detection.
 *
 * Pure-function tests for `lib/utils/in-app-browser.ts:inspectUserAgent`.
 * Covers the 12 IN_APP_PATTERNS plus the iOS heuristic (no Safari/ +
 * iPhone → in-app).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectUserAgent } from "@/lib/utils/in-app-browser";

describe("MONEY-393 §14 - in-app-browser UA detection", () => {
  it("[ua] null/undefined → not in-app, label 'browser'", () => {
    assert.deepEqual(inspectUserAgent(null), {
      isInAppBrowser: false,
      clientLabel: "browser",
    });
    assert.deepEqual(inspectUserAgent(undefined), {
      isInAppBrowser: false,
      clientLabel: "browser",
    });
    assert.deepEqual(inspectUserAgent(""), {
      isInAppBrowser: false,
      clientLabel: "browser",
    });
  });

  it("[ua] regular Chrome on desktop is NOT in-app", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    assert.equal(inspectUserAgent(ua).isInAppBrowser, false);
  });

  it("[ua] mobile Safari on iPhone is NOT in-app (has Safari/ token)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    assert.equal(inspectUserAgent(ua).isInAppBrowser, false);
  });

  it("[ua] Chrome on Android is NOT in-app", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
    assert.equal(inspectUserAgent(ua).isInAppBrowser, false);
  });

  it("[ua] Instagram in-app → Instagram label", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 (KHTML) Mobile Instagram 290.0.0";
    const r = inspectUserAgent(ua);
    assert.equal(r.isInAppBrowser, true);
    assert.equal(r.clientLabel, "Instagram");
  });

  it("[ua] Facebook (FBAV/FBIOS/FB_IAB) → Facebook label", () => {
    assert.equal(
      inspectUserAgent("Mozilla/5.0 FBAV/400.0").clientLabel,
      "Facebook"
    );
    assert.equal(inspectUserAgent("Mozilla/5.0 FBIOS").clientLabel, "Facebook");
    assert.equal(inspectUserAgent("FB_IAB/FB4A").clientLabel, "Facebook");
  });

  it("[ua] WhatsApp / LinkedIn / Twitter / Threads → respective labels", () => {
    assert.equal(
      inspectUserAgent("Mozilla/5.0 WhatsApp/2.23").clientLabel,
      "WhatsApp"
    );
    assert.equal(
      inspectUserAgent("Mozilla/5.0 LinkedInApp/1.0").clientLabel,
      "LinkedIn"
    );
    assert.equal(
      inspectUserAgent("Mozilla/5.0 Twitter for iPhone").clientLabel,
      "Twitter / X"
    );
    assert.equal(
      inspectUserAgent("Mozilla/5.0 ThreadsApp/1.0").clientLabel,
      "Threads"
    );
  });

  it("[ua] WeChat / Line / Telegram → respective labels", () => {
    assert.equal(
      inspectUserAgent("Mozilla/5.0 MicroMessenger/8.0").clientLabel,
      "WeChat"
    );
    assert.equal(
      inspectUserAgent("Mozilla/5.0 Line/12.0.0").clientLabel,
      "Line"
    );
    assert.equal(
      inspectUserAgent("Mozilla/5.0 Telegram/8.0").clientLabel,
      "Telegram"
    );
  });

  it("[ua] Android WebView marker `; wv)` → in-app", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; SM-G991B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0";
    assert.equal(inspectUserAgent(ua).isInAppBrowser, true);
  });

  it("[ua] iOS heuristic: iPhone + no Safari/ + no known mobile browser → in-app", () => {
    // UIWebView / WKWebView without the Safari user-agent override -
    // a real risk on iOS in-app browsers (Apple blocks programmatic
    // escape so we must at least warn the user).
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
    const r = inspectUserAgent(ua);
    assert.equal(r.isInAppBrowser, true);
    assert.equal(r.clientLabel, "in-app browser");
  });

  it("[ua] iOS Chrome (CriOS) is NOT in-app even without Safari/ token", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0";
    assert.equal(
      inspectUserAgent(ua).isInAppBrowser,
      false,
      "iOS Chrome is a real browser; the Safari-token heuristic must allow it"
    );
  });

  it("[ua] iOS Firefox (FxiOS) and Edge (EdgiOS) also pass through", () => {
    assert.equal(
      inspectUserAgent("Mozilla/5.0 (iPhone) FxiOS/120.0").isInAppBrowser,
      false
    );
    assert.equal(
      inspectUserAgent("Mozilla/5.0 (iPhone) EdgiOS/120.0").isInAppBrowser,
      false
    );
  });

  it("[ua] Electron-based apps detected", () => {
    assert.equal(
      inspectUserAgent("Mozilla/5.0 (X11; Linux x86_64) Electron/27.0")
        .isInAppBrowser,
      true
    );
  });

  it("[ua] in-app detection is case-insensitive", () => {
    // Patterns use /i flag - sanity-check.
    assert.equal(
      inspectUserAgent("Mozilla/5.0 INSTAGRAM 290").isInAppBrowser,
      true
    );
    assert.equal(
      inspectUserAgent("Mozilla/5.0 instagram 290").isInAppBrowser,
      true
    );
  });
});
