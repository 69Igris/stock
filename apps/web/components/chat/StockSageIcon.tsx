import { Sparkles } from "lucide-react";

/**
 * StockSage brand icon - emerald gradient square with ₹ symbol.
 * Use this everywhere StockSage is referenced (chat header, sidebar, prompts).
 *
 * `variant`:
 *   - "rupee" (default) - the ₹ brand mark.
 *   - "sparkle" - the playful assistant avatar (MONEY-485): emerald square,
 *     hand-drawn -3° tilt, ink border + offset shadow, sparkle glyph. Matches
 *     the design's AI-message avatar.
 */
export function StockSageIcon({
  size = 28,
  className,
  variant = "rupee",
}: {
  size?: number;
  className?: string;
  variant?: "rupee" | "sparkle";
}) {
  const fontSize = Math.round(size * 0.4);
  const radius = Math.round(size * 0.26);

  if (variant === "sparkle") {
    return (
      <div
        className={className}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: "var(--emerald)",
          display: "grid",
          placeItems: "center",
          color: "var(--paper)",
          border: "1.5px solid var(--ink)",
          transform: "rotate(-3deg)",
          flexShrink: 0,
        }}
      >
        <Sparkles size={Math.round(size * 0.52)} strokeWidth={2.2} />
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: "linear-gradient(135deg, #34d399, #10b981)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#16140e",
        fontWeight: 800,
        fontFamily: "var(--font-mono)",
        fontSize,
        flexShrink: 0,
        boxShadow: "0 0 12px rgba(52,211,153,0.3)",
      }}
    >
      ₹
    </div>
  );
}
