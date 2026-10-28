"use client";

import "./auth.css";

import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import AuthBrandPanel, { type AuthKind } from "./AuthBrandPanel";

/**
 * Split-layout shell for the playful auth pages (MONEY-484).
 * Left = theme-aware form panel (page-supplied `children`).
 * Right = permanently-dark brand panel.
 * On <=980px the brand panel is hidden and a compact read-only strip
 * stands in for it (see auth.css).
 */
export default function AuthShell({
  kind = "in",
  children,
}: {
  kind?: AuthKind;
  children: React.ReactNode;
}) {
  return (
    <div className="auth-page">
      <div className="auth-split">
        <div className="auth-left">
          <div className="auth-topbar">
            <Link className="auth-back" href="/home">
              <ArrowLeft size={14} />
              Back to home
            </Link>
            <AnimatedThemeToggler
              className="auth-theme-tog"
              aria-label="Toggle theme"
            />
          </div>

          {children}

          {/* Stands in for the brand panel on mobile. */}
          <div className="auth-mobile-strip">
            <ShieldCheck size={18} color="#1d1d1b" />
            <span className="t">
              <strong>Read-only OAuth</strong> · we can never place orders on
              your behalf.
            </span>
          </div>
        </div>

        <AuthBrandPanel kind={kind} />
      </div>
    </div>
  );
}
