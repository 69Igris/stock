"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "@usemoney/utils";

const SCROLL_THRESHOLD = 300;

export default function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setVisible(window.scrollY > SCROLL_THRESHOLD);
    };

    // Check initial position (e.g. page refreshed while scrolled)
    handleScroll();

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Scroll to top"
      /* Bottom-right stack, from the floor up (MONEY-1151):
           bottom nav .......... 0 → --mobile-nav-h
           Ask FIRE / Screener .. +1.5rem  (~40px tall)
           this button .......... +5rem
         5rem clears the launcher with a ~16px gap. --mobile-nav-h is 0 on
         marketing and auth routes (no bar mounted) and at lg, so this resolves
         to the 80px it has always been everywhere the bar isn't. The `, 0px`
         fallback keeps `bottom` valid if globals.css isn't loaded — without it
         the declaration is dropped and a fixed button falls back to `auto`. */
      style={{ bottom: "calc(var(--mobile-nav-h, 0px) + 5rem)" }}
      className={cn(
        "fixed right-6 z-40 h-10 w-10 rounded-full",
        "bg-muted/80 hover:bg-accent border border-border",
        "text-foreground/80 hover:text-foreground",
        "flex items-center justify-center",
        /* opacity+transform only, NOT transition-all: this button is mounted
           once in the root layout and never unmounts, so `bottom` changes
           whenever the user moves between a route that has the bottom bar and
           one that doesn't (--mobile-nav-h 60px → 0). Under transition-all that
           60px delta animates as a visible slide instead of just being applied.
           Those two properties are all the show/hide animation needs. */
        "transition-[opacity,transform] duration-300 ease-in-out",
        "shadow-lg backdrop-blur-sm",
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-4 pointer-events-none"
      )}
    >
      <ChevronUp className="h-5 w-5" />
    </button>
  );
}
