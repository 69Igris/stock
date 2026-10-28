"use client";

/**
 * Square violet-tinted logo placeholder for the Fund detail identity
 * header (MONEY-245). Mirrors `StockLogoPlaceholder` in spirit but
 * uses a stack icon and a violet-anchored palette so funds visually
 * read different from stocks at a glance.
 *
 * Hue is hashed off the scheme code so the same fund always lights up
 * the same color across visits.
 */

import { Layers } from "lucide-react";

const PALETTE = [
  {
    bg: "rgba(167,139,250,.16)",
    border: "rgba(167,139,250,.3)",
    icon: "#a78bfa",
  }, // violet (default)
  {
    bg: "rgba(96,165,250,.16)",
    border: "rgba(96,165,250,.3)",
    icon: "#60a5fa",
  }, // blue
  {
    bg: "rgba(244,114,182,.16)",
    border: "rgba(244,114,182,.3)",
    icon: "#f472b6",
  }, // pink
  {
    bg: "rgba(52,211,153,.16)",
    border: "rgba(52,211,153,.3)",
    icon: "#34d399",
  }, // emerald
  {
    bg: "rgba(251,191,36,.16)",
    border: "rgba(251,191,36,.3)",
    icon: "#fbbf24",
  }, // amber
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function FundLogoPlaceholder({
  schemeCode,
  size = 56,
}: {
  schemeCode: string;
  size?: number;
}) {
  const c = PALETTE[hash(schemeCode) % PALETTE.length] ?? PALETTE[0]!;
  return (
    <div
      className="grid place-items-center rounded-[10px] shrink-0"
      style={{
        width: size,
        height: size,
        background: c.bg,
        border: `1px solid ${c.border}`,
      }}
      aria-hidden
    >
      <Layers
        style={{
          color: c.icon,
          width: Math.round(size * 0.45),
          height: Math.round(size * 0.45),
        }}
      />
    </div>
  );
}

export default FundLogoPlaceholder;
