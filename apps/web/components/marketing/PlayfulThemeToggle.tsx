"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { animateThemeTransition } from "@/components/ui/animated-theme-toggler";

/**
 * Playful theme toggle — drives next-themes via the shared
 * `animateThemeTransition` helper. Click triggers a View Transition API
 * circular clip-path reveal originating from the button itself; falls
 * back to an instant switch on browsers without VT support (Firefox <125).
 * Sun icon when dark, moon icon when light (CSS in playful.css shows/
 * hides the icons via html.dark).
 */
export function PlayfulThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  const toggle = () => {
    if (!mounted) return;
    const next = resolvedTheme === "dark" ? "light" : "dark";
    animateThemeTransition(next, setTheme, btnRef.current, 420);
  };

  return (
    <button
      type="button"
      ref={btnRef}
      className="theme-tog"
      aria-label="Toggle theme"
      onClick={toggle}
    >
      <svg
        className="moon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      <svg
        className="sun"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    </button>
  );
}
