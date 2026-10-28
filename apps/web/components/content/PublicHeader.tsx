"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { ThemedUserButton } from "@/components/ThemedUserButton";
import {
  Menu,
  ChevronDown,
  FileText,
  BookA,
  Scroll,
  Scale,
} from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "@usemoney/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@usemoney/ui/sheet";
import UseMoneyLogo from "@/components/UseMoneyLogo";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { cn } from "@/lib/utils";

const resourceLinks = [
  {
    href: "/blog",
    label: "Blog",
    icon: FileText,
    description: "Market insights & trading strategies",
  },
  {
    href: "/glossary",
    label: "Glossary",
    icon: BookA,
    description: "Financial terms explained",
  },
  {
    href: "/docs",
    label: "Docs",
    icon: Scroll,
    description: "Platform documentation",
  },
  {
    href: "/alternatives",
    label: "Compare",
    icon: Scale,
    description: "See how we stack up",
  },
];

export function PublicHeader() {
  const pathname = usePathname();
  const { user, isLoaded } = useUser();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isResourcePage = resourceLinks.some((link) =>
    pathname.startsWith(link.href)
  );

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-[200] transition-all duration-300",
        scrolled
          ? "bg-[var(--nav-bg-scrolled)] backdrop-blur-[20px] border-b border-[var(--border-default)]"
          : "bg-transparent border-b border-transparent"
      )}
    >
      <div className="max-w-[1200px] mx-auto px-6 h-[60px] flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <Link href="/home" className="flex items-center gap-2">
            <UseMoneyLogo size={32} />
            <span className="text-lg font-bold tracking-tight text-[var(--text-primary)]">
              UseMoney
              <span className="text-[var(--accent-primary)]">.</span>
            </span>
          </Link>
        </div>

        {/* Desktop Nav */}
        <div className="hidden sm:flex items-center gap-7">
          <Link
            href="/home#features"
            className="text-[var(--text-dim)] hover:text-[var(--accent-primary)] text-sm font-medium transition-colors"
          >
            Features
          </Link>
          <Link
            href="/pricing"
            className={cn(
              "text-sm font-medium transition-colors",
              pathname === "/pricing"
                ? "text-[var(--accent-primary)]"
                : "text-[var(--text-dim)] hover:text-[var(--accent-primary)]"
            )}
          >
            Pricing
          </Link>

          {/* Resources Dropdown */}
          <div
            className="relative"
            onMouseEnter={() => setResourcesOpen(true)}
            onMouseLeave={() => setResourcesOpen(false)}
          >
            <button
              className={cn(
                "flex items-center gap-1 text-sm font-medium transition-colors",
                isResourcePage
                  ? "text-[var(--accent-primary)]"
                  : "text-[var(--text-dim)] hover:text-[var(--accent-primary)]"
              )}
              onClick={() => setResourcesOpen((v) => !v)}
            >
              Resources
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${resourcesOpen ? "rotate-180" : ""}`}
              />
            </button>

            {resourcesOpen && (
              <div className="absolute top-full left-0 pt-2 z-50">
                <div
                  className="w-64 rounded-xl overflow-hidden"
                  style={{
                    background: "var(--paper)",
                    border: "2px solid var(--ink)",
                    boxShadow: "4px 4px 0 var(--ink)",
                  }}
                >
                  {resourceLinks.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={cn(
                        "flex items-start gap-3 px-4 py-3 transition-colors",
                        pathname.startsWith(link.href)
                          ? "bg-[var(--emerald-bg)]"
                          : "hover:bg-[var(--rule-softer)]"
                      )}
                      onClick={() => setResourcesOpen(false)}
                    >
                      <link.icon className="h-4 w-4 text-[var(--emerald-text)] mt-0.5 shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-[var(--ink)]">
                          {link.label}
                        </div>
                        <div className="text-xs text-[var(--ink-3)]">
                          {link.description}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Theme Toggle */}
          <AnimatedThemeToggler
            iconSize="h-5 w-5"
            className="p-2 rounded-lg text-[var(--text-dim)] hover:text-[var(--text-primary)] hover:bg-accent transition-colors"
          />

          {/* Auth-aware CTA */}
          {isLoaded && user ? (
            <div className="flex items-center gap-3">
              <Link href="/dashboard">
                <Button className="bg-gradient-to-r from-emerald-400 to-emerald-500 hover:from-emerald-500 hover:to-emerald-600 text-[var(--text-inverse)] font-semibold shadow-[var(--shadow-glow)] border-0">
                  Go to Dashboard
                </Button>
              </Link>
              <ThemedUserButton />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Link href="/sign-in">
                <Button
                  variant="ghost"
                  className="text-[var(--text-dim)] hover:text-[var(--text-primary)]"
                >
                  Sign In
                </Button>
              </Link>
              <Link href="/sign-up">
                <Button className="bg-gradient-to-r from-emerald-400 to-emerald-500 hover:from-emerald-500 hover:to-emerald-600 text-[var(--text-inverse)] font-semibold shadow-[var(--shadow-glow)] border-0 rounded-lg px-4 py-2 text-[13.5px]">
                  Get Started →
                </Button>
              </Link>
            </div>
          )}
        </div>

        {/* Mobile Menu */}
        <div className="sm:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-[var(--text-primary)]"
              >
                <Menu className="h-6 w-6" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-64 p-6"
              style={{
                background: "var(--paper)",
                borderLeft: "2px solid var(--ink)",
              }}
            >
              <div className="flex flex-col gap-4 mt-8">
                <Link
                  href="/home#features"
                  className="text-[var(--ink-2)] hover:text-[var(--emerald-text)] py-2 transition-colors"
                  onClick={() => setMobileOpen(false)}
                >
                  Features
                </Link>
                <Link
                  href="/pricing"
                  className="text-[var(--ink-2)] hover:text-[var(--emerald-text)] py-2 transition-colors"
                  onClick={() => setMobileOpen(false)}
                >
                  Pricing
                </Link>
                <div className="um-label pt-2">Resources</div>
                {resourceLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={cn(
                      "text-[var(--ink-2)] hover:text-[var(--emerald-text)] py-2 flex items-center gap-2 pl-2 transition-colors",
                      pathname.startsWith(link.href) &&
                        "text-[var(--accent-primary)]"
                    )}
                    onClick={() => setMobileOpen(false)}
                  >
                    <link.icon className="h-4 w-4 text-[var(--emerald-text)]" />
                    {link.label}
                  </Link>
                ))}
                <div className="border-t border-[var(--rule-soft)] pt-4">
                  <div className="flex items-center justify-between px-1 mb-4">
                    <span className="text-sm text-[var(--ink-3)]">Theme</span>
                    <AnimatedThemeToggler
                      iconSize="h-5 w-5"
                      className="p-2 rounded-lg text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-accent transition-colors"
                    />
                  </div>
                  <div className="border-t border-[var(--rule-soft)] mb-4" />
                  <div className="space-y-3">
                    {isLoaded && user ? (
                      <>
                        <Link
                          href="/dashboard"
                          onClick={() => setMobileOpen(false)}
                        >
                          <Button className="w-full bg-gradient-to-r from-emerald-400 to-emerald-500 hover:from-emerald-500 hover:to-emerald-600 text-[var(--text-inverse)] font-semibold border-0">
                            Go to Dashboard
                          </Button>
                        </Link>
                        <div className="flex items-center justify-center pt-2">
                          <ThemedUserButton />
                        </div>
                      </>
                    ) : (
                      <>
                        <Link
                          href="/sign-in"
                          onClick={() => setMobileOpen(false)}
                        >
                          <Button
                            variant="outline"
                            className="w-full border-[var(--ink)] text-[var(--ink-2)]"
                          >
                            Sign In
                          </Button>
                        </Link>
                        <Link
                          href="/sign-up"
                          onClick={() => setMobileOpen(false)}
                        >
                          <Button className="w-full bg-gradient-to-r from-emerald-400 to-emerald-500 hover:from-emerald-500 hover:to-emerald-600 text-[var(--text-inverse)] font-semibold border-0">
                            Get Started →
                          </Button>
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
