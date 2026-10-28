"use client";

/**
 * Notice shown when the user is inside an in-app browser (Instagram /
 * WhatsApp / etc.) instead of a real OS browser. Google blocks OAuth from
 * WebViews, so we have to tell the user to copy the link to Safari/Chrome
 * before they hit "Sign in" or "Try Demo".
 */

import { useEffect, useState } from "react";
import { ExternalLink, Copy, Check } from "lucide-react";
import {
  getBrowserInfo,
  getPlatform,
  tryEscapeInAppBrowser,
  type BrowserInfo,
} from "@/lib/utils/in-app-browser";

interface InAppBrowserNoticeProps {
  /** Optional override of the call-to-action verb. Defaults to "sign in". */
  action?: string;
  className?: string;
}

export function InAppBrowserNotice({
  action = "sign in",
  className,
}: InAppBrowserNoticeProps) {
  const [info, setInfo] = useState<BrowserInfo>({
    isInAppBrowser: false,
    clientLabel: "browser",
  });
  const [platform, setPlatform] = useState<"android" | "ios" | "other">(
    "other"
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setInfo(getBrowserInfo());
    setPlatform(getPlatform());
  }, []);

  if (!info.isInAppBrowser) return null;

  const url =
    typeof window !== "undefined"
      ? window.location.href
      : "https://usemoney.ai";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard API blocked in some WebViews - fall back to selecting
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      } catch {
        /* no-op - user will have to manually copy */
      }
      document.body.removeChild(input);
    }
  };

  return (
    <div
      role="alert"
      className={`rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3.5 ${
        className ?? ""
      }`}
    >
      <div className="flex items-start gap-2.5">
        <ExternalLink className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-amber-300 mb-0.5">
            Open in your browser to {action}
          </div>
          <div className="text-[12.5px] text-[var(--text-dim)] leading-relaxed">
            Google blocks {action} from inside the {info.clientLabel} app for
            security.{" "}
            {platform === "android"
              ? "Tap “Open in Chrome” below, or use the menu (⋯) → “Open in Chrome”."
              : platform === "ios"
                ? "Tap the menu (⋯) at the top of this app and choose “Open in Safari” / “Open in External Browser”, or copy the link below."
                : "Open this URL in Safari or Chrome to continue."}
          </div>
          <div className="mt-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <code className="flex-1 min-w-0 text-[11.5px] font-mono text-[var(--text-secondary)] bg-black/30 border border-[var(--border-default)] rounded px-2 py-1.5 truncate">
              {url}
            </code>
            <div className="flex gap-2">
              {platform === "android" && (
                <button
                  onClick={() => tryEscapeInAppBrowser()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-emerald-400/15 border border-emerald-400/35 text-emerald-300 text-[11.5px] font-semibold hover:bg-emerald-400/25 transition-colors cursor-pointer shrink-0"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in Chrome
                </button>
              )}
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-amber-400/15 border border-amber-400/30 text-amber-300 text-[11.5px] font-semibold hover:bg-amber-400/25 transition-colors cursor-pointer shrink-0"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copy link
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default InAppBrowserNotice;
