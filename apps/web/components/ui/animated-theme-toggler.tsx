"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";

/**
 * Animate a theme change with the View Transition API (circular clip-path reveal).
 * Falls back to instant switch on unsupported browsers.
 *
 * @param newTheme - "light", "dark", or "system"
 * @param setTheme - next-themes setTheme function
 * @param originEl - optional element to use as animation origin (defaults to center of screen)
 * @param duration - animation duration in ms
 */
export function animateThemeTransition(
  newTheme: string,
  setTheme: (theme: string) => void,
  originEl?: HTMLElement | null,
  duration = 400
) {
  // Determine the resolved class to apply
  let resolvedClass = newTheme;
  if (newTheme === "system") {
    resolvedClass = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  const applyTheme = () => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(resolvedClass);
    setTheme(newTheme);
  };

  // Compute animation origin
  let x: number, y: number;
  if (originEl) {
    const rect = originEl.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  } else {
    x = window.innerWidth / 2;
    y = window.innerHeight / 2;
  }

  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const maxRadius = Math.hypot(
    Math.max(x, viewportWidth - x),
    Math.max(y, viewportHeight - y)
  );

  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> };
  };

  if (!doc.startViewTransition) {
    applyTheme();
    return;
  }

  const transition = doc.startViewTransition(applyTheme);

  transition.ready.then(() => {
    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${maxRadius}px at ${x}px ${y}px)`,
        ],
      },
      {
        duration,
        easing: "ease-in-out",
        pseudoElement: "::view-transition-new(root)",
      }
    );
  });
}

// ---------------------------------------------------------------------------
// AnimatedThemeToggler button component
// ---------------------------------------------------------------------------

interface AnimatedThemeTogglerProps extends React.ComponentPropsWithoutRef<"button"> {
  duration?: number;
  iconSize?: string;
}

export const AnimatedThemeToggler = ({
  className,
  duration = 400,
  iconSize = "h-4 w-4",
  ...props
}: AnimatedThemeTogglerProps) => {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  const toggleTheme = useCallback(() => {
    const newTheme = isDark ? "light" : "dark";
    animateThemeTransition(newTheme, setTheme, buttonRef.current, duration);
  }, [isDark, duration, setTheme]);

  if (!mounted) {
    return (
      <button type="button" className={cn(className)} {...props} disabled>
        <Moon className={cn(iconSize, "opacity-0")} />
        <span className="sr-only">Toggle theme</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={toggleTheme}
      className={cn(className)}
      {...props}
    >
      {isDark ? <Sun className={iconSize} /> : <Moon className={iconSize} />}
      <span className="sr-only">Toggle theme</span>
    </button>
  );
};
