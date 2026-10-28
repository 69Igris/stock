"use client";

/**
 * PfUserProfileMenu (MONEY-489) — playful 320 px profile card rendered inside
 * the desktop sidebar DropdownMenu. Implements the full design spec:
 *   · Header: round gradient avatar + name/email
 *   · Plan strip: gold PRO card with badge + credits + renew date (or FREE
 *     upgrade CTA)
 *   · Group 1: Feedback, Subscription, Theme 3-toggle
 *   · Group 2: Settings, Take the tour again (emerald), Home Page, Help
 *   · Log out with coral sticker icon
 *
 * All handlers are passed in as props so the caller (Sidebar.tsx UserMenu)
 * retains 100% of the existing logic — this component is purely presentational.
 * Styling is in co-located `profile-menu.css`; never touches playful-app.css.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";
import {
  MessageSquarePlus,
  Bookmark,
  Sun,
  Monitor,
  Moon,
  Settings,
  Sparkles,
  Briefcase,
  HelpCircle,
  LogOut,
  ChevronRight,
  User,
  Crown,
  CreditCard,
  Activity,
  Sliders,
  Bell,
  ShieldCheck,
  Plug,
  Compass,
  Terminal,
  BookOpen,
  FileText,
  MessageSquareText,
  type LucideIcon,
} from "lucide-react";
import "./profile-menu.css";

// ---------------------------------------------------------------------------
// Submenu configs — mirror the real Settings + Help sub-navs so the chevron
// rows expand into the same sections those pages expose (deep-links via ?tab=).
// ---------------------------------------------------------------------------

interface SubItem {
  label: string;
  href: string;
  Icon: LucideIcon;
}

// Mirrors app/settings/client.tsx NAV (Feedback omitted — it's a top-level
// item already). Deep-links to /settings?tab=<id>.
const SETTINGS_SUB: SubItem[] = [
  { label: "Account", href: "/settings?tab=account", Icon: User },
  { label: "Plans", href: "/settings?tab=plans", Icon: Crown },
  { label: "Billing", href: "/settings?tab=billing", Icon: CreditCard },
  { label: "Usage", href: "/settings?tab=usage", Icon: Activity },
  { label: "Preferences", href: "/settings?tab=preferences", Icon: Sliders },
  { label: "Notifications", href: "/settings?tab=notifications", Icon: Bell },
  { label: "Security", href: "/settings?tab=security", Icon: ShieldCheck },
  { label: "Integrations", href: "/settings?tab=integrations", Icon: Plug },
];

// Mirrors app/help/client.tsx TABS. Deep-links to /help?tab=<value>.
const HELP_SUB: SubItem[] = [
  { label: "Prompts", href: "/help?tab=prompts", Icon: Compass },
  { label: "Commands", href: "/help?tab=slash-commands", Icon: Terminal },
  { label: "Guides", href: "/help?tab=guides", Icon: BookOpen },
  { label: "Docs", href: "/help?tab=docs", Icon: FileText },
  { label: "FAQ", href: "/help?tab=faq", Icon: MessageSquareText },
  { label: "Glossary", href: "/help?tab=glossary", Icon: HelpCircle },
];

// ---------------------------------------------------------------------------
// Sub-component: icon tile (sticker style)
// ---------------------------------------------------------------------------

function IcTile({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "emerald" | "coral";
}) {
  return (
    <span
      className={`pf-pm-ic${variant !== "default" ? ` ${variant}` : ""}`}
      aria-hidden
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: menu item row
// ---------------------------------------------------------------------------

function MenuItem({
  icon,
  label,
  right,
  hasChevron,
  expanded,
  onClick,
  onMouseEnter,
  onFocus,
}: {
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode;
  hasChevron?: boolean;
  /** When set, the chevron rotates 90° to signal an expanded submenu. */
  expanded?: boolean;
  onClick?: () => void;
  /** Hover opens/closes the side-flyout (#121). */
  onMouseEnter?: () => void;
  /** Keyboard parity for hover — focusing a row mirrors the hover intent so
   *  Tab/arrow navigation opens/closes submenus the same way the mouse does. */
  onFocus?: () => void;
}) {
  return (
    <button
      type="button"
      className="pf-pm-item"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
      aria-expanded={hasChevron ? !!expanded : undefined}
    >
      <IcTile>{icon}</IcTile>
      <span className="pf-pm-item-label">{label}</span>
      {right}
      {hasChevron && (
        <ChevronRight
          size={13}
          style={{
            color: "var(--ink-3)",
            flexShrink: 0,
            transition: "transform .15s ease",
            transform: expanded ? "rotate(90deg)" : "none",
          }}
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: expandable submenu list (Settings / Help sections)
// ---------------------------------------------------------------------------

function SubMenu({
  items,
  onNavigate,
}: {
  items: SubItem[];
  onNavigate: (href: string) => void;
}) {
  return (
    <div className="pf-pm-sub" role="group">
      {items.map(({ label, href, Icon }) => (
        <button
          key={href}
          type="button"
          className="pf-pm-subitem"
          onClick={() => onNavigate(href)}
        >
          <Icon size={12} className="pf-pm-sub-ic" aria-hidden />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: the row-anchored flyout that lifts itself up if the row is
// low enough that the submenu would overflow the viewport bottom (#127/#128).
// ---------------------------------------------------------------------------

/** Keep this far from the viewport bottom edge when shifting up. */
const BOTTOM_BUFFER = 16;

function SubmenuFlyout({
  label,
  items,
  onNavigate,
  onMouseEnter,
}: {
  label: string;
  items: SubItem[];
  onNavigate: (href: string) => void;
  /** Hovering INTO the flyout must keep it open (re-assert expanded state)
   *  so moving the cursor from the trigger row onto the submenu doesn't
   *  close it via the parent group's close-on-hover handler. */
  onMouseEnter?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset to natural position before measuring so re-renders don't compound.
    el.style.top = "0px";
    const rect = el.getBoundingClientRect();
    const overflow = rect.bottom - (window.innerHeight - BOTTOM_BUFFER);
    setTopOffset(overflow > 0 ? -overflow : 0);
  }, []);

  return (
    <div
      ref={ref}
      className="pf-pm-flyout"
      aria-label={label}
      style={{ top: topOffset }}
      onMouseEnter={onMouseEnter}
    >
      <div className="pf-pm-flyout-head">{label}</div>
      <SubMenu items={items} onNavigate={onNavigate} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan strip helpers
// ---------------------------------------------------------------------------

function formatResetDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PfUserProfileMenuProps {
  /** Display name (from Clerk user.fullName / firstName). */
  userName: string;
  /** Primary email address. */
  userEmail?: string;
  /** Optional Clerk imageUrl — if present renders a real avatar. */
  userImage?: string;

  /** Current plan id: "PRO" | "PREMIUM" | "FREE" | … or null while the
   *  subscription is still loading (renders a neutral skeleton, never "Free"). */
  planId: string | null;
  /** Remaining credits for the current period (pass undefined to hide). */
  creditsLimit?: number | null;
  /** Used credits for the current period. */
  creditsUsed?: number | null;
  /** ISO date when credits reset / subscription renews. */
  creditsResetAt?: string | null;
  /** ISO date of next billing cycle (fallback to creditsResetAt). */
  nextBillingDate?: string | null;

  /** Opens /settings?tab=feedback */
  onFeedback: () => void;
  /** Opens /settings?tab=plans */
  onSubscription: () => void;
  /** Navigate to an arbitrary in-app href (Settings/Help submenu deep-links,
   *  incl. the "All settings" / "Help center" rows). Caller should router.push
   *  + close the menu. */
  onNavigate: (href: string) => void;
  /** Replays the walkthrough (calls triggerWalkthroughRestart). */
  onTourAgain: () => void;
  /** Navigates to /home */
  onHomePage: () => void;
  /** Sign out (or end-demo) handler. */
  onLogOut: () => void;

  /** Label for the log-out button (defaults to "Log out"). */
  logOutLabel?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PfUserProfileMenu({
  userName,
  userEmail,
  userImage,
  planId,
  creditsLimit,
  creditsUsed,
  creditsResetAt,
  nextBillingDate,
  onFeedback,
  onSubscription,
  onNavigate,
  onTourAgain,
  onHomePage,
  onLogOut,
  logOutLabel = "Log out",
}: PfUserProfileMenuProps) {
  // Mount gate: avoid hydration mismatch for theme state
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Which chevron row is expanded into its submenu (accordion; one at a time).
  const [expanded, setExpanded] = useState<"settings" | "help" | null>(null);

  // Hover/focus over any NON-chevron row collapses an open submenu, so the
  // flyout behaves like a real menu: it auto-closes the moment the pointer
  // moves to a different item, instead of waiting for a manual arrow click.
  // The chevron rows set their own key on hover; the flyout re-asserts it on
  // mouse-enter so crossing the gap from trigger → submenu doesn't dismiss it.
  const closeSubmenu = () => setExpanded(null);

  const { theme, setTheme } = useTheme();
  // resolvedTheme reflects the actual applied theme (handles "system").
  // We use `theme` (the stored preference) for the toggle active state, but
  // fall back to detecting "system" when it equals "system" or is undefined.
  const activeThemeKey = !mounted ? "system" : (theme ?? "system");

  const initials =
    userName
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "U";

  // ── Plan strip ──────────────────────────────────────────────────────────
  // planId === null → still loading; render a neutral skeleton rather than
  // asserting "Free" (which mis-labelled paying users during the fetch).
  const planKnown = planId != null;
  const isPaidPlan = planId === "PRO" || planId === "PREMIUM";
  const planLabel = isPaidPlan ? `UseMoney ${planId}` : "Free Plan";
  const renewDate = formatResetDate(nextBillingDate ?? creditsResetAt);

  // Credits line — only show when we have reliable numbers
  let creditsLine: string | null = null;
  if (isPaidPlan && typeof creditsLimit === "number" && creditsLimit > 0) {
    const remaining = Math.max(
      0,
      creditsLimit - (typeof creditsUsed === "number" ? creditsUsed : 0)
    );
    creditsLine = `${remaining} / ${creditsLimit} credits`;
    if (renewDate) creditsLine += ` · renews ${renewDate}`;
  } else if (isPaidPlan && creditsLimit === -1) {
    creditsLine = "Unlimited credits";
    if (renewDate) creditsLine += ` · renews ${renewDate}`;
  }

  return (
    <div className="pf-profile-menu">
      {/* ── Header ── */}
      <div className="pf-pm-header" onMouseEnter={closeSubmenu}>
        <div className="pf-pm-av">
          {userImage ? (
            <Image
              src={userImage}
              alt={userName}
              width={40}
              height={40}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            initials
          )}
        </div>
        <div className="pf-pm-user">
          <div className="pf-pm-name">{userName}</div>
          {userEmail && <div className="pf-pm-email mono">{userEmail}</div>}
        </div>
      </div>

      {/* ── Plan strip ── */}
      {!planKnown ? (
        // Loading skeleton — never assert FREE before the plan resolves.
        <div className="pf-pm-plan loading" aria-busy="true">
          <span
            className="pf-pm-skel"
            style={{ width: 36, height: 16, borderRadius: 4 }}
          />
          <div className="pf-pm-plan-info">
            <span className="pf-pm-skel" style={{ width: 92, height: 12 }} />
            <span
              className="pf-pm-skel"
              style={{ width: 132, height: 10, marginTop: 6 }}
            />
          </div>
        </div>
      ) : (
        <div
          className={`pf-pm-plan${isPaidPlan ? "" : " upgrade"}`}
          onMouseEnter={closeSubmenu}
        >
          <span className="pf-pm-plan-badge">
            {isPaidPlan ? planId : "FREE"}
          </span>
          <div className="pf-pm-plan-info">
            <div className="pf-pm-plan-name">{planLabel}</div>
            {creditsLine && (
              <div className="pf-pm-plan-meta mono">{creditsLine}</div>
            )}
            {!isPaidPlan && (
              <div className="pf-pm-plan-meta mono">
                Upgrade for full access →
              </div>
            )}
          </div>
          <button
            type="button"
            className="pf-bs sm"
            onClick={onSubscription}
            style={{ fontSize: 11.5, padding: "5px 9px", flexShrink: 0 }}
          >
            {isPaidPlan ? "Manage" : "Go PRO"}
          </button>
        </div>
      )}

      {/* ── Group 1: Feedback · Subscription · Theme ── */}
      <div className="pf-pm-group">
        <MenuItem
          icon={<MessageSquarePlus size={13} />}
          label="Feedback"
          onClick={onFeedback}
          onMouseEnter={closeSubmenu}
          onFocus={closeSubmenu}
        />
        <MenuItem
          icon={<Bookmark size={13} />}
          label="Subscription"
          onClick={onSubscription}
          onMouseEnter={closeSubmenu}
          onFocus={closeSubmenu}
          right={
            planKnown ? (
              <span
                className="pf-pill outline"
                style={{ fontSize: 9.5, flexShrink: 0 }}
              >
                {planId === "FREE" ? "FREE" : planId}
              </span>
            ) : undefined
          }
        />

        {/* Theme row with 3-button segmented toggle */}
        <div className="pf-pm-theme-row" onMouseEnter={closeSubmenu}>
          <IcTile>
            <Sun size={13} />
          </IcTile>
          <span className="pf-pm-theme-label">Theme</span>
          <div className="pf-pm-theme-seg" role="group" aria-label="Theme">
            {(
              [
                { key: "system", Icon: Monitor, title: "System" },
                { key: "light", Icon: Sun, title: "Light" },
                { key: "dark", Icon: Moon, title: "Dark" },
              ] as const
            ).map(({ key, Icon, title }) => (
              <button
                key={key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setTheme(key);
                }}
                title={title}
                className={`pf-pm-theme-btn${activeThemeKey === key ? " active" : ""}`}
                aria-pressed={activeThemeKey === key}
              >
                <Icon size={12} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Group 2: Settings · Tour · Home · Help ── */}
      {/* Each chevron row is wrapped in .pf-pm-item-wrap so its flyout
          positions relative to THAT row (top:0 = row's top), aligning the
          submenu with the trigger like the reference design (#122/#123). */}
      <div className="pf-pm-group">
        <div className="pf-pm-item-wrap">
          <MenuItem
            icon={<Settings size={13} />}
            label="Settings"
            hasChevron
            expanded={expanded === "settings"}
            onMouseEnter={() => setExpanded("settings")}
            onFocus={() => setExpanded("settings")}
            onClick={() =>
              setExpanded(expanded === "settings" ? null : "settings")
            }
          />
          {expanded === "settings" && (
            <SubmenuFlyout
              label="Settings"
              items={[
                { label: "All settings", href: "/settings", Icon: Settings },
                ...SETTINGS_SUB,
              ]}
              onNavigate={onNavigate}
              onMouseEnter={() => setExpanded("settings")}
            />
          )}
        </div>
        <button
          type="button"
          className="pf-pm-item"
          onClick={onTourAgain}
          onMouseEnter={closeSubmenu}
          onFocus={closeSubmenu}
        >
          <IcTile variant="emerald">
            <Sparkles size={13} />
          </IcTile>
          <span className="pf-pm-item-label">Take the tour again</span>
        </button>
        <MenuItem
          icon={<Briefcase size={13} />}
          label="Home Page"
          onClick={onHomePage}
          onMouseEnter={closeSubmenu}
          onFocus={closeSubmenu}
        />
        <div className="pf-pm-item-wrap">
          <MenuItem
            icon={<HelpCircle size={13} />}
            label="Help"
            hasChevron
            expanded={expanded === "help"}
            onMouseEnter={() => setExpanded("help")}
            onFocus={() => setExpanded("help")}
            onClick={() => setExpanded(expanded === "help" ? null : "help")}
          />
          {expanded === "help" && (
            <SubmenuFlyout
              label="Help"
              items={[
                { label: "Help center", href: "/help", Icon: HelpCircle },
                ...HELP_SUB,
              ]}
              onNavigate={onNavigate}
              onMouseEnter={() => setExpanded("help")}
            />
          )}
        </div>
      </div>

      {/* ── Log out ── */}
      <div className="pf-pm-footer">
        <button
          type="button"
          className="pf-pm-logout"
          onClick={onLogOut}
          onMouseEnter={closeSubmenu}
          onFocus={closeSubmenu}
        >
          <IcTile variant="coral">
            <LogOut size={13} />
          </IcTile>
          {logOutLabel}
        </button>
      </div>
    </div>
  );
}
