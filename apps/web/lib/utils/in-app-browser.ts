/**
 * In-app browser (WebView) detection.
 *
 * Why: Google blocks OAuth requests originating from embedded WebViews with
 * `Error 403: disallowed_useragent` ("Use secure browsers" policy). Users
 * coming from Instagram / WhatsApp / Twitter / LinkedIn / Facebook in-app
 * browsers will hit this wall when they tap "Sign in with Google" or "Try
 * Demo". We can't fix Google's policy - we can only detect the browser and
 * tell the user to open the link in Safari/Chrome before they click.
 *
 * Detection covers the common in-app browsers and Android's `wv)` WebView
 * marker. iOS Safari-on-iPhone-without-Safari-string is the trickiest case
 * (iOS WebViews don't always declare themselves) - we use the absence of
 * `Safari/` together with iPhone/iPad as a heuristic.
 */

const IN_APP_PATTERNS = [
  /fbav|fbios|fb_iab/i, // Facebook
  /instagram/i, // Instagram
  /line\//i, // Line
  /micromessenger/i, // WeChat
  /twitter/i, // Twitter / X
  /whatsapp/i, // WhatsApp
  /linkedinapp/i, // LinkedIn
  /threadsapp/i, // Threads
  /telegram/i, // Telegram (some builds)
  /discordbot/i, // Discord
  /electron/i, // Electron-based apps
  /; wv\)/i, // Android WebView signature
];

export interface BrowserInfo {
  /** True if the user-agent looks like an in-app browser / WebView. */
  isInAppBrowser: boolean;
  /** A short label for the detected client, useful for the notice copy. */
  clientLabel: string;
}

/** Inspect a UA string and decide whether it's an in-app WebView. */
export function inspectUserAgent(ua: string | null | undefined): BrowserInfo {
  if (!ua) return { isInAppBrowser: false, clientLabel: "browser" };

  // Common-case named in-app browsers
  for (const pattern of IN_APP_PATTERNS) {
    if (pattern.test(ua)) {
      return { isInAppBrowser: true, clientLabel: labelFromUA(ua) };
    }
  }

  // iOS heuristic: iPhone/iPad but no `Safari/` token usually means an
  // embedded WebView (UIWebView / WKWebView without the Safari user-agent
  // override). Real Mobile Safari always includes `Safari/<version>`.
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const hasSafari = /safari\//i.test(ua);
  const hasKnownMobileBrowser = /(crios|fxios|edgios|opios)/i.test(ua);
  if (isIos && !hasSafari && !hasKnownMobileBrowser) {
    return { isInAppBrowser: true, clientLabel: "in-app browser" };
  }

  return { isInAppBrowser: false, clientLabel: "browser" };
}

function labelFromUA(ua: string): string {
  if (/instagram/i.test(ua)) return "Instagram";
  if (/fbav|fbios|fb_iab/i.test(ua)) return "Facebook";
  if (/whatsapp/i.test(ua)) return "WhatsApp";
  if (/linkedinapp/i.test(ua)) return "LinkedIn";
  if (/twitter/i.test(ua)) return "Twitter / X";
  if (/threadsapp/i.test(ua)) return "Threads";
  if (/line\//i.test(ua)) return "Line";
  if (/micromessenger/i.test(ua)) return "WeChat";
  if (/telegram/i.test(ua)) return "Telegram";
  return "in-app browser";
}

/** Client-side convenience. Returns false on the server (SSR-safe). */
export function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return inspectUserAgent(navigator.userAgent).isInAppBrowser;
}

export function getBrowserInfo(): BrowserInfo {
  if (typeof navigator === "undefined")
    return { isInAppBrowser: false, clientLabel: "browser" };
  return inspectUserAgent(navigator.userAgent);
}

/** Best-effort platform detection. Used to pick the right escape strategy. */
export function getPlatform(): "android" | "ios" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  return "other";
}

/**
 * Attempt to escape the in-app WebView and reopen the same URL in the OS
 * browser. Mostly works on Android (Chrome intent URI). iOS Apple blocks
 * any silent escape - the only iOS path is for the user to use the host
 * app's "..." menu. This function returns `true` when an escape was
 * attempted, `false` when the platform offers no programmatic option.
 */
export function tryEscapeInAppBrowser(): boolean {
  if (typeof window === "undefined") return false;
  const url = window.location.href;
  const platform = getPlatform();

  if (platform === "android") {
    // Chrome intent URI - opens in Chrome on Android, ignored elsewhere.
    // The fragment uri ensures the user lands on the same page in Chrome.
    const intent = `intent://${url.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;end`;
    window.location.href = intent;
    return true;
  }

  // iOS / other: no reliable programmatic escape.
  return false;
}
