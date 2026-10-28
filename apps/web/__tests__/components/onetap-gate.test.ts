/**
 * MONEY-440 - OneTapGate render decision.
 *
 * The component itself is two lines of JSX; the load-bearing logic is
 * "should we render `GoogleOneTap` for this UA?". That decision is a
 * pure function of `inspectUserAgent(ua).isInAppBrowser`. These tests
 * pin the contract so a future change to either the gate or the UA
 * patterns can't silently regress us back to firing One-Tap inside
 * Instagram / WhatsApp / etc.
 *
 * Regression context: MONEY-211 added WebView detection on HeroSection
 * + SignInModal but left the root-layout `<GoogleOneTap>` ungated, so
 * users inside Instagram saw the prompt auto-fire and hit Google's
 * `disallowed_useragent` 403 wall.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectUserAgent } from "@/lib/utils/in-app-browser";

/**
 * Mirror of the decision inside `apps/web/components/OneTapGate.tsx`.
 * Keeping it pure lets us assert across realistic UAs without booting
 * React.
 */
function shouldRenderOneTap(ua: string | null | undefined): boolean {
  return !inspectUserAgent(ua).isInAppBrowser;
}

describe("MONEY-440 - OneTapGate render decision", () => {
  describe("must NOT render One-Tap (WebView UAs)", () => {
    const blockedUAs: Array<[string, string]> = [
      [
        "Instagram on iOS",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.34.111 (iPhone15,2; iOS 17_0; en_IN; en-IN; scale=3.00; 1179x2556; 542287306)",
      ],
      [
        "Instagram on Android",
        "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.5993.80 Mobile Safari/537.36 Instagram 308.0.0.36.109 Android (33/13; 420dpi; 1080x2208; Google/google; Pixel 7; panther; panther; en_IN; 542287306)",
      ],
      [
        "WhatsApp in-app browser",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.23.20.86",
      ],
      [
        "Facebook iOS app",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.32.107]",
      ],
      [
        "Twitter / X in-app",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone",
      ],
      [
        "LinkedIn in-app",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedInApp",
      ],
      [
        "Threads in-app",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Barcelona 312.0 ThreadsApp",
      ],
      [
        "Android WebView (generic wv marker)",
        "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.5993.80 Mobile Safari/537.36",
      ],
    ];

    for (const [label, ua] of blockedUAs) {
      it(`blocks One-Tap inside ${label}`, () => {
        assert.equal(
          shouldRenderOneTap(ua),
          false,
          `Expected One-Tap to be suppressed for ${label}; UA: ${ua}`
        );
      });
    }
  });

  describe("must render One-Tap (real OS browsers)", () => {
    const allowedUAs: Array<[string, string]> = [
      [
        "Mobile Safari on iPhone",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ],
      [
        "Chrome on Android",
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.80 Mobile Safari/537.36",
      ],
      [
        "Desktop Chrome on Mac",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ],
      [
        "Desktop Safari on Mac",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      ],
      [
        "Firefox on Windows",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
      ],
      [
        "Chrome on iPhone (CriOS)",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/118.0.5993.69 Mobile/15E148 Safari/604.1",
      ],
      [
        "Firefox on iPhone (FxiOS)",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15",
      ],
    ];

    for (const [label, ua] of allowedUAs) {
      it(`allows One-Tap inside ${label}`, () => {
        assert.equal(
          shouldRenderOneTap(ua),
          true,
          `Expected One-Tap to render for ${label}; UA: ${ua}`
        );
      });
    }
  });

  describe("SSR-safe defaults", () => {
    it("renders One-Tap when the UA is unknown (server / pre-mount)", () => {
      // `null`/`undefined` flows to inspectUserAgent's "no UA" branch,
      // which returns `isInAppBrowser: false`. The actual component
      // overrides this to `false` until useEffect runs (SSR returns
      // null) - the post-mount path is what this test pins.
      assert.equal(shouldRenderOneTap(null), true);
      assert.equal(shouldRenderOneTap(undefined), true);
      assert.equal(shouldRenderOneTap(""), true);
    });
  });

  describe("regression invariants", () => {
    it("does not regress on a UA that combines Instagram + Chrome substrings", () => {
      // Older detection bugs that whitelisted "Chrome" eagerly would
      // miss Instagram-on-Android because its UA contains both. Pin
      // that the more specific pattern still wins.
      const ua =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 Chrome/118 Mobile Instagram 308";
      assert.equal(shouldRenderOneTap(ua), false);
    });

    it("Mobile Safari has both 'Safari/' and 'iPhone' - allowed", () => {
      // The iOS heuristic only fires when Safari/ is missing. A real
      // mobile Safari UA must not be blocked.
      const ua =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
      assert.equal(shouldRenderOneTap(ua), true);
    });

    it("iOS without Safari/ token (suspicious WebView) is blocked", () => {
      // Common pattern when an embedded WebView strips the Safari token.
      const ua =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
      assert.equal(shouldRenderOneTap(ua), false);
    });
  });
});
