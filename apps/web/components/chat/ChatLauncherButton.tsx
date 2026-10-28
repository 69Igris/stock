"use client";

/**
 * ChatLauncherButton — the floating "Ask <X>" pill (MONEY-1151).
 *
 * WHY THIS EXISTS
 * ---------------
 * The same launcher was hand-copied into AskFirePanel, AskScreenerPanel and
 * EmbeddedChatPanel. When the button turned out to be buried under
 * GlobalMobileBottomNav, the same one-line bug had to be fixed in three files —
 * and the regression guard has to enumerate those files by path for the same
 * reason. This is the single definition of the launcher's geometry; the panels
 * supply only what actually differs (icon, label, handler).
 *
 * GEOMETRY CONTRACT
 * -----------------
 * - `bottom` clears GlobalMobileBottomNav via --mobile-nav-h, which is 0 on
 *   desktop and on routes where the bar isn't mounted, so the pill keeps its
 *   original 24px there. The `, 0px` fallback matters: an undefined custom
 *   property with no fallback makes the whole declaration invalid at
 *   computed-value time and `bottom` silently becomes `auto`, dropping a fixed
 *   button at its static position. That happens in any renderer that mounts
 *   this without globals.css (Storybook, jsdom snapshots).
 * - `z-40`, deliberately NOT z-50. The More drawer is z-49 over a z-48
 *   backdrop; at z-50 the pill floated undimmed above the open drawer and ate
 *   taps meant for its nav items. z-40 sits under the backdrop and dims with
 *   the rest of the page, matching ScrollToTop.
 */

import { forwardRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@usemoney/utils";

/** Distance from the top of the bottom nav (or the viewport floor without it). */
export const LAUNCHER_BOTTOM = "calc(var(--mobile-nav-h, 0px) + 1.5rem)";

interface ChatLauncherButtonProps {
  onClick: () => void;
  /** Accessible/hover label, e.g. "Open Ask FIRE". */
  title: string;
  /** Icon element; rendered before the label. */
  children: ReactNode;
  className?: string;
  /** Merged AFTER the defaults, so a caller can genuinely override `bottom` —
      an inline style outranks every class, so a caller-supplied `bottom-*`
      class could not otherwise take effect. */
  style?: CSSProperties;
}

const ChatLauncherButton = forwardRef<
  HTMLButtonElement,
  ChatLauncherButtonProps
>(function ChatLauncherButton(
  { onClick, title, children, className, style },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn("fixed right-6 z-40 pf-bs", className)}
      style={{
        padding: "10px 18px",
        borderRadius: 12,
        bottom: LAUNCHER_BOTTOM,
        ...style,
      }}
      title={title}
    >
      {children}
    </button>
  );
});

export default ChatLauncherButton;
