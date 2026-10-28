"use client";

import { useEffect, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { useTheme } from "next-themes";

type UserButtonProps = React.ComponentProps<typeof UserButton>;

/**
 * Theme-aware <UserButton/>.
 *
 * Clerk v5 styles its widgets (incl. the Account/Profile modal opened from the
 * avatar) via the per-component `appearance` prop. The root ClerkProvider can't
 * read the app theme (it's a server boundary), so each UserButton must supply
 * its own theme-aware appearance. This mirrors the proven pattern in
 * components/marketing/PlayfulHeader.tsx so the popover matches the playful
 * surface in BOTH light and dark — fixing the "Clerk module not theme aware"
 * regression after the app default flipped to light (MONEY-484).
 *
 * A mount gate avoids a hydrate-mismatch on first paint (resolvedTheme is
 * undefined during SSR).
 */
export function ThemedUserButton(props: UserButtonProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";

  const appearance = {
    baseTheme: isDark ? dark : undefined,
    variables: {
      colorPrimary: isDark ? "#34d399" : "#16a34a",
    },
    elements: {
      avatarBox: "h-9 w-9",
      userButtonPopoverFooter: "hidden",
    },
  };

  return <UserButton {...props} appearance={appearance} />;
}
