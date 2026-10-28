"use client";

import { useTheme } from "next-themes";
import { Toaster } from "sonner";
import "./ThemedToaster.css";

/**
 * ThemedToaster — playful re-skin (MONEY-484).
 *
 * Maps sonner variants to the ToastStack design from screens-qa-essentials.jsx:
 *
 *   success  → paper bg · 2px emerald border · 3px emerald offset shadow
 *              · rotated emerald icon square (via CSS class)
 *   info     → paper bg · 2px ink border · 3px ink shadow
 *   error    → paper bg · 2px #b91c1c border · 3px red shadow
 *   warning  → paper bg · 2px gold (--pop-2) border · 3px gold shadow
 *   loading  → ink (#1d1d1b) bg · cream text · emerald progress bar
 *   default  → paper bg · 2px ink border · 3px ink shadow
 *
 * All tokens derive from playful-app.css vars that flip with html.dark, so
 * the toasts stay theme-aware without hardcoded RGBA. Behaviour (position,
 * close button, queuing) is unchanged.
 */
export function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      richColors
      position="bottom-right"
      closeButton
      theme={(resolvedTheme as "dark" | "light") ?? "dark"}
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: "pf-toast",
          title: "pf-toast-title",
          description: "pf-toast-desc",
          closeButton: "pf-toast-close",
          success: "pf-toast--success",
          info: "pf-toast--info",
          error: "pf-toast--error",
          warning: "pf-toast--warning",
          loading: "pf-toast--loading",
        },
      }}
    />
  );
}
