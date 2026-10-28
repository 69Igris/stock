/**
 * MONEY-393 §36 - lib/utils/in-app-browser.ts coverage push (75.6% → 90%+).
 *
 * §14 (in-app-browser.test.ts, 14 cases) covered inspectUserAgent.
 * Remaining gap: getBrowserInfo / getPlatform (client-side wrappers
 * that read navigator) + tryEscapeInAppBrowser (Android intent URI).
 *
 * Strategy: stub global navigator + window so the client-side wrappers
 * walk both the SSR-undefined branch and the navigator-present branch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isInAppBrowser,
  getBrowserInfo,
  getPlatform,
  tryEscapeInAppBrowser,
} from "@/lib/utils/in-app-browser";

interface MutableGlobal {
  navigator?: { userAgent?: string } | undefined;
  window?: { location?: { href?: string } } | undefined;
}

function withGlobals(
  navigatorVal: { userAgent: string } | undefined,
  windowVal: { location: { href: string } } | undefined,
  fn: () => void
): void {
  const g = globalThis as unknown as MutableGlobal;
  const savedNav = g.navigator;
  const savedWin = g.window;
  if (navigatorVal === undefined) delete g.navigator;
  else g.navigator = navigatorVal;
  if (windowVal === undefined) delete g.window;
  else g.window = windowVal;
  try {
    fn();
  } finally {
    if (savedNav === undefined) delete g.navigator;
    else g.navigator = savedNav;
    if (savedWin === undefined) delete g.window;
    else g.window = savedWin;
  }
}

describe("MONEY-393 §36 - in-app-browser client wrappers", () => {
  it("[isInAppBrowser] returns false on SSR (no navigator)", () => {
    withGlobals(undefined, undefined, () => {
      assert.equal(isInAppBrowser(), false);
    });
  });

  it("[isInAppBrowser] returns true when navigator.userAgent matches Instagram", () => {
    withGlobals(
      { userAgent: "Mozilla/5.0 (iPhone) Instagram 290.0" },
      undefined,
      () => {
        assert.equal(isInAppBrowser(), true);
      }
    );
  });

  it("[isInAppBrowser] returns false for regular Chrome desktop", () => {
    withGlobals(
      {
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537.36",
      },
      undefined,
      () => {
        assert.equal(isInAppBrowser(), false);
      }
    );
  });

  it("[getBrowserInfo] SSR returns default { isInAppBrowser:false, clientLabel:'browser' }", () => {
    withGlobals(undefined, undefined, () => {
      const info = getBrowserInfo();
      assert.equal(info.isInAppBrowser, false);
      assert.equal(info.clientLabel, "browser");
    });
  });

  it("[getBrowserInfo] returns label for detected in-app browser", () => {
    withGlobals({ userAgent: "Mozilla/5.0 WhatsApp/2.23" }, undefined, () => {
      const info = getBrowserInfo();
      assert.equal(info.isInAppBrowser, true);
      assert.equal(info.clientLabel, "WhatsApp");
    });
  });

  it("[getPlatform] returns 'other' on SSR", () => {
    withGlobals(undefined, undefined, () => {
      assert.equal(getPlatform(), "other");
    });
  });

  it("[getPlatform] android UA → 'android'", () => {
    withGlobals(
      { userAgent: "Mozilla/5.0 (Linux; Android 13; SM-G991B)" },
      undefined,
      () => {
        assert.equal(getPlatform(), "android");
      }
    );
  });

  it("[getPlatform] iPhone UA → 'ios'", () => {
    withGlobals(
      { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" },
      undefined,
      () => {
        assert.equal(getPlatform(), "ios");
      }
    );
  });

  it("[getPlatform] iPad UA → 'ios'", () => {
    withGlobals(
      { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" },
      undefined,
      () => {
        assert.equal(getPlatform(), "ios");
      }
    );
  });

  it("[getPlatform] desktop UA → 'other'", () => {
    withGlobals(
      { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0" },
      undefined,
      () => {
        assert.equal(getPlatform(), "other");
      }
    );
  });

  it("[tryEscapeInAppBrowser] returns false on SSR (no window)", () => {
    withGlobals(undefined, undefined, () => {
      assert.equal(tryEscapeInAppBrowser(), false);
    });
  });

  it("[tryEscapeInAppBrowser] iOS → returns false (no programmatic escape)", () => {
    let assignedHref: string | null = null;
    const win = {
      location: {
        set href(v: string) {
          assignedHref = v;
        },
        get href(): string {
          return "https://usemoney.ai/holdings";
        },
      },
    };
    withGlobals(
      { userAgent: "Mozilla/5.0 (iPhone) Instagram 290.0" },
      win as never,
      () => {
        const result = tryEscapeInAppBrowser();
        assert.equal(result, false, "iOS has no programmatic escape");
        assert.equal(assignedHref, null, "no redirect attempted on iOS");
      }
    );
  });

  it("[tryEscapeInAppBrowser] Android → returns true + sets intent URI", () => {
    let assignedHref: string | null = null;
    const win = {
      location: {
        get href(): string {
          return "https://usemoney.ai/holdings";
        },
        set href(v: string) {
          assignedHref = v;
        },
      },
    };
    withGlobals(
      { userAgent: "Mozilla/5.0 (Linux; Android 13) Instagram 290.0" },
      win as never,
      () => {
        const result = tryEscapeInAppBrowser();
        assert.equal(result, true, "Android escape returns true");
        assert.ok(
          assignedHref !== null,
          "Android escape must assign to window.location.href"
        );
        // Intent URI format check.
        assert.ok(
          assignedHref!.startsWith("intent://"),
          `expected intent:// URI, got: ${assignedHref}`
        );
        assert.ok(
          assignedHref!.includes("scheme=https"),
          "intent URI must carry scheme=https"
        );
        assert.ok(
          assignedHref!.includes("package=com.android.chrome"),
          "intent URI must target Chrome"
        );
      }
    );
  });
});
