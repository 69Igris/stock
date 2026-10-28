"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { dark } from "@clerk/themes";

/**
 * Clerk appearance for the playful auth pages (MONEY-484).
 *
 * Uses the same clean shadcn-semantic styling the original auth module had
 * (bg-card / text-foreground / bg-secondary / border) — which now auto-flips
 * to the warm playful palette in BOTH themes because the MONEY-485 token
 * remap re-pointed those tokens. We only:
 *   - flip baseTheme per theme (the root ClerkProvider forces `dark`),
 *   - hide the logo + title (our hero already names the page; the subtitle
 *     stays for verify-email / reset-password step context),
 *   - mark backgrounds `!important` so the child class deterministically
 *     wins over the root provider's concatenated element classes.
 */
export function useAuthClerkAppearance() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Default to dark before mount (matches ThemeProvider defaultTheme="dark").
  const isDark = !mounted || resolvedTheme === "dark";

  // Per-theme variables so Clerk internals not covered by element classes
  // don't inherit the root provider's dark colorBackground in light mode.
  const variables = isDark
    ? {
        colorPrimary: "#34d399",
        colorBackground: "#1f1c14",
        colorInputBackground: "#1a1810",
        colorInputText: "#f4ede0",
        colorText: "#f4ede0",
        colorTextSecondary: "#a09a8d",
        borderRadius: "0.6rem",
        fontFamily: "Inter, system-ui, sans-serif",
      }
    : {
        colorPrimary: "#16a34a",
        colorBackground: "#fbf8eb",
        colorInputBackground: "#fbf8eb",
        colorInputText: "#1d1d1b",
        colorText: "#1d1d1b",
        colorTextSecondary: "#6b6b62",
        borderRadius: "0.6rem",
        fontFamily: "Inter, system-ui, sans-serif",
      };

  return {
    baseTheme: isDark ? dark : undefined,
    variables,
    elements: {
      rootBox: "w-full",
      card: "!bg-card border border-border shadow-lg rounded-2xl",
      logoBox: "hidden",
      headerTitle: "hidden",
      headerSubtitle: "text-muted-foreground",
      socialButtonsBlockButton:
        "!bg-secondary hover:!bg-secondary/70 border border-border text-foreground",
      socialButtonsBlockButtonText: "text-foreground font-semibold",
      dividerLine: "bg-border",
      dividerText: "text-muted-foreground",
      formFieldLabel: "text-foreground font-medium",
      formFieldInput: "!bg-background border-input text-foreground",
      formButtonPrimary:
        "bg-emerald-500 hover:bg-emerald-600 text-[#16140e] font-semibold normal-case",
      footerActionLink: "text-emerald-500 hover:text-emerald-400 font-medium",
      identityPreviewText: "text-foreground",
      identityPreviewEditButton: "text-emerald-500",
      otpCodeFieldInput: "border-input text-foreground",
      formResendCodeLink: "text-emerald-500",
    },
  };
}
