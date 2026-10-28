"use client";

/**
 * Square emerald-tinted logo placeholder used in the stock detail
 * identity header. Shows the first letter of the symbol - same pattern
 * Tickertape uses when an actual logo asset is unavailable.
 *
 * The plate hue is derived deterministically from the symbol so a given
 * stock always gets the same color across visits, but the universe of
 * stocks lights up with visual variety.
 */

const PALETTE = [
  {
    bg: "rgba(52,211,153,.14)",
    border: "rgba(52,211,153,.3)",
    text: "#34d399",
  }, // emerald
  {
    bg: "rgba(167,139,250,.14)",
    border: "rgba(167,139,250,.3)",
    text: "#a78bfa",
  }, // violet
  {
    bg: "rgba(96,165,250,.14)",
    border: "rgba(96,165,250,.3)",
    text: "#60a5fa",
  }, // blue
  {
    bg: "rgba(251,191,36,.14)",
    border: "rgba(251,191,36,.3)",
    text: "#fbbf24",
  }, // amber
  {
    bg: "rgba(244,114,182,.14)",
    border: "rgba(244,114,182,.3)",
    text: "#f472b6",
  }, // pink
  {
    bg: "rgba(248,113,113,.14)",
    border: "rgba(248,113,113,.3)",
    text: "#f87171",
  }, // red
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface StockLogoPlaceholderProps {
  symbol: string;
  size?: number;
}

export function StockLogoPlaceholder({
  symbol,
  size = 56,
}: StockLogoPlaceholderProps) {
  const c = PALETTE[hash(symbol) % PALETTE.length] ?? PALETTE[0]!;
  const letter = (symbol[0] ?? "·").toUpperCase();
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
      <span
        className="font-display font-bold leading-none"
        style={{
          color: c.text,
          fontSize: Math.round(size * 0.5),
          letterSpacing: "-0.02em",
        }}
      >
        {letter}
      </span>
    </div>
  );
}

export default StockLogoPlaceholder;
