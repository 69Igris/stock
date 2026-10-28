"use client";

import Image from "next/image";

interface UseMoneyLogoProps {
  size?: number;
  className?: string;
}

/**
 * Single source of truth for the UseMoney brand mark.
 *
 * Uses `/icon.svg` - the emerald-gradient rounded-square "M" mark. The same
 * file is mirrored in every app's `public/` so a future redesign means
 * editing exactly one SVG and copying it across apps. Theme-agnostic: the
 * mark is high-contrast on both light and dark backgrounds, so we no longer
 * swap variants on theme change (eliminates a hydration flash).
 */
export default function UseMoneyLogo({
  size = 40,
  className = "rounded-sm",
}: UseMoneyLogoProps) {
  return (
    <Image
      src="/icon.svg"
      alt="UseMoney"
      width={size}
      height={size}
      className={className}
      priority
    />
  );
}
