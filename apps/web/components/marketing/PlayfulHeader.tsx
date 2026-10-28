"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useUser, UserButton, useClerk } from "@clerk/nextjs";
import { instantSignOut } from "@/lib/auth/sign-out";
import { dark } from "@clerk/themes";
import { useTheme } from "next-themes";
import { PlayfulThemeToggle } from "./PlayfulThemeToggle";
import { Menu, X } from "lucide-react";

const NAV_LINKS = [{ href: "/pricing", label: "Pricing" }];

const PRODUCT = [
  {
    href: "/features",
    label: "Features",
    sub: "Multi-broker, AI research, paper trading",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2" />
      </svg>
    ),
  },
  {
    href: "/integrations",
    label: "Brokers",
    sub: "8 supported · read-only OAuth",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    href: "/alternatives",
    label: "Compare",
    sub: "UseMoney vs other platforms",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 3l4 4-4 4" />
        <path d="M20 7H4" />
        <path d="M8 21l-4-4 4-4" />
        <path d="M4 17h16" />
      </svg>
    ),
  },
  {
    href: "/roadmap",
    label: "Roadmap",
    sub: "What's shipping next 3 months",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
        <path d="M9 3v15" />
        <path d="M15 6v15" />
      </svg>
    ),
  },
  {
    href: "/changelog",
    label: "Changelog",
    sub: "What we ship, weekly",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
];

const RESOURCES = [
  {
    href: "/docs",
    label: "Docs",
    sub: "Get started, brokers, AI, security",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
  },
  {
    href: "/glossary",
    label: "Glossary",
    sub: "Indian-markets terms",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    ),
  },
  {
    href: "/blog",
    label: "Blog",
    sub: "Long reads on Indian markets",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 22h16a2 2 0 0 0 2-2V8l-7-7H6a2 2 0 0 0-2 2v3" />
        <path d="M14 2v6h6" />
      </svg>
    ),
  },
];

type NavItem = {
  href: string;
  label: string;
  sub: string;
  icon: React.ReactNode;
};

function NavDropdown({
  label,
  items,
  open,
  onOpen,
  onClose,
  onToggle,
}: {
  label: string;
  items: NavItem[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={`nav-drop ${open ? "is-open" : ""}`}
      onMouseEnter={onOpen}
      onMouseLeave={onClose}
    >
      <button
        type="button"
        className="nav-drop-btn"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={onToggle}
      >
        {label}
        <svg
          className="caret"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className="nav-drop-panel">
        {items.map((r, i) => (
          // `Newsletter` shares href with Blog · disambiguate the React key.
          <Link
            key={`${r.href}-${i}-${r.label}`}
            href={r.href}
            onClick={onClose}
          >
            <span className="ic">{r.icon}</span>
            <span className="body">
              <span className="t">{r.label}</span>
              <span className="s">{r.sub}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function MobileNavDropdown({
  label,
  items,
}: {
  label: string;
  items: NavItem[];
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Mirror NavDropdown: collapse the inline submenu when the route changes
  // so the next page doesn't open with a pre-expanded Product/Resources panel.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  return (
    <div className={`nav-drop ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="nav-drop-btn"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        <svg
          className="caret"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className="nav-drop-panel">
        {items.map((r, i) => (
          <Link key={`${r.href}-${i}-${r.label}`} href={r.href}>
            <span className="ic">{r.icon}</span>
            <span className="body">
              <span className="t">{r.label}</span>
              <span className="s">{r.sub}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function PlayfulHeader() {
  const pathname = usePathname();
  const { user, isLoaded } = useUser();
  const { signOut, openUserProfile } = useClerk();
  const [menuOpen, setMenuOpen] = useState(false);
  // Single source of truth for which desktop dropdown is open (by label, or
  // null). Lifting this to the parent guarantees only one panel is ever open
  // and lets us close it from global (outside-click / Escape) handlers.
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const navLinksRef = useRef<HTMLElement | null>(null);
  const { resolvedTheme } = useTheme();
  // Mount gate so the Clerk popover doesn't hydrate-mismatch on first paint.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Let Clerk's own built-in dark/light theme handle all contrast internally;
  // we only inject the brand primary color on top.
  const isDark = mounted && resolvedTheme === "dark";
  const clerkAppearance = {
    baseTheme: isDark ? dark : undefined,
    variables: {
      colorPrimary: isDark ? "#34d399" : "#16a34a",
    },
    elements: {
      avatarBox: "h-9 w-9",
      userButtonPopoverFooter: "hidden",
    },
  };

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  // Close menu + any open dropdown on route change. Same-section navigation
  // (e.g. /docs → /blog inside Resources) can leave the cursor on the panel so
  // onMouseLeave never fires; force-close on every pathname change.
  useEffect(() => {
    setMenuOpen(false);
    setOpenDropdown(null);
  }, [pathname]);

  // Close the open dropdown on outside click (anywhere outside the desktop nav)
  // and on Escape. Only attach while a dropdown is actually open.
  useEffect(() => {
    if (!openDropdown) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (
        navLinksRef.current &&
        !navLinksRef.current.contains(e.target as Node)
      ) {
        setOpenDropdown(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenDropdown(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openDropdown]);

  const signedIn = isLoaded && !!user;

  const renderCTA = (forMobile = false) => {
    if (!isLoaded) {
      // Avoid layout flicker while Clerk resolves
      return (
        <div
          style={{ width: forMobile ? "100%" : 120, height: 36 }}
          aria-hidden
        />
      );
    }
    if (signedIn) {
      // Mobile drawer: the avatar already lives in the top bar, so a second
      // bare avatar here is redundant. Show explicit, theme-aware actions.
      if (forMobile) {
        return (
          <div className="mobile-acct">
            <Link
              className="btn-solid"
              href="/dashboard"
              onClick={() => setMenuOpen(false)}
            >
              Dashboard →
            </Link>
            <button
              type="button"
              className="mobile-acct-row"
              onClick={() => {
                setMenuOpen(false);
                openUserProfile();
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden width="18" height="18">
                <circle
                  cx="12"
                  cy="8"
                  r="3.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                />
                <path
                  d="M5 19.2c.7-3.1 3.5-4.7 7-4.7s6.3 1.6 7 4.7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              Manage account
            </button>
            <button
              type="button"
              className="mobile-acct-row danger"
              onClick={() => {
                setMenuOpen(false);
                instantSignOut(signOut);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden width="18" height="18">
                <path
                  d="M14 4h3.2A1.8 1.8 0 0 1 19 5.8v12.4A1.8 1.8 0 0 1 17.2 20H14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
                <path
                  d="M9 8l-4 4 4 4M5 12h10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Log out
            </button>
          </div>
        );
      }
      return (
        <>
          <Link className="btn-solid" href="/dashboard">
            Dashboard →
          </Link>
          {/* Clerk v7 removed `afterSignOutUrl` from <UserButton>; "/home" is
              configured on <ClerkProvider> in app/layout.tsx. */}
          <UserButton appearance={clerkAppearance} />
        </>
      );
    }
    return (
      <>
        <Link className="btn-flat" href="/sign-in">
          Sign in
        </Link>
        <Link className="btn-solid" href="/sign-up">
          Start free →
        </Link>
      </>
    );
  };

  return (
    <>
      <header className="nav">
        <div className="container nav-inner">
          <Link
            className="brand"
            href="/home"
            onClick={() => setMenuOpen(false)}
          >
            <span className="brand-mark">U</span>
            <span>
              UseMoney<span className="brand-ai">AI</span>
            </span>
          </Link>
          <nav className="nav-links" ref={navLinksRef}>
            <NavDropdown
              label="Product"
              items={PRODUCT}
              open={openDropdown === "Product"}
              onOpen={() => setOpenDropdown("Product")}
              onClose={() =>
                setOpenDropdown((cur) => (cur === "Product" ? null : cur))
              }
              onToggle={() =>
                setOpenDropdown((cur) => (cur === "Product" ? null : "Product"))
              }
            />
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={pathname === l.href ? "is-active" : undefined}
                // A plain nav link is not a dropdown trigger, but clicking one
                // is "clicking a different nav button" — close any open panel.
                onClick={() => setOpenDropdown(null)}
              >
                {l.label}
              </Link>
            ))}
            <NavDropdown
              label="Resources"
              items={RESOURCES}
              open={openDropdown === "Resources"}
              onOpen={() => setOpenDropdown("Resources")}
              onClose={() =>
                setOpenDropdown((cur) => (cur === "Resources" ? null : cur))
              }
              onToggle={() =>
                setOpenDropdown((cur) =>
                  cur === "Resources" ? null : "Resources"
                )
              }
            />
          </nav>
          <div className="nav-cta">
            <PlayfulThemeToggle />
            {renderCTA(false)}
            <button
              type="button"
              className={`hamburger ${menuOpen ? "is-x" : ""}`}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {/* Standard hamburger ↔ X icon swap (lucide). The CSS class
                  retains its sizing/border treatment from playful.css. */}
              {menuOpen ? (
                <X size={22} strokeWidth={2} />
              ) : (
                <Menu size={22} strokeWidth={2} />
              )}
            </button>
          </div>
        </div>
      </header>

      <div
        className="mobile-menu"
        style={{ transform: menuOpen ? "translateY(0)" : "translateY(-110%)" }}
      >
        <MobileNavDropdown label="Product" items={PRODUCT} />
        {NAV_LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={pathname === l.href ? "is-active" : undefined}
          >
            {l.label}
          </Link>
        ))}
        <MobileNavDropdown label="Resources" items={RESOURCES} />
        <div className="mobile-menu-cta">{renderCTA(true)}</div>
      </div>
    </>
  );
}
