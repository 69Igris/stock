"use client";

/**
 * MONEY-440: Suppress Clerk's Google One-Tap inside in-app browsers.
 *
 * Google blocks OAuth requests originating from WebViews
 * (`Error 403: disallowed_useragent`, "Use secure browsers" policy).
 * MONEY-211 wired up WebView detection on the interactive surfaces -
 * the hero Get Started button refuses with a toast, the SignInModal
 * renders an `InAppBrowserNotice` - but the root-layout `GoogleOneTap`
 * was never gated. Inside Instagram / WhatsApp / FB / Twitter the
 * prompt fires anyway and lands the user on Google's 403 wall.
 *
 * SSR-safe: on the server we render `null` (no UA available); after
 * mount we read `navigator.userAgent` once and only render One-Tap
 * when we're sure we're in a real OS browser. Real browsers behave
 * exactly as before.
 */

import { useEffect, useState } from "react";
import { GoogleOneTap } from "@clerk/nextjs";
import { getBrowserInfo } from "@/lib/utils/in-app-browser";

/**
 * MONEY-881: One Tap behavior (Google Identity Services + FedCM, both on by
 * default): a SINGLE signed-in Google account signs in/up directly; MULTIPLE
 * accounts show the account chooser. That's the desired UX, so One Tap renders
 * normally (Clerk also auto-hides it once the user is already signed in).
 */
export default function OneTapGate() {
  const [allow, setAllow] = useState(false);

  useEffect(() => {
    setAllow(!getBrowserInfo().isInAppBrowser);
  }, []);

  if (!allow) return null;
  return (
    <GoogleOneTap
      signInForceRedirectUrl="/dashboard"
      signUpForceRedirectUrl="/dashboard"
    />
  );
}
