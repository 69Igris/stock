/**
 * Playful placeholder components — drop-in chart/content skeletons.
 *
 * Usage:
 *   import { PfLinePlaceholder, PfBarsPlaceholder } from "@/components/playful/placeholders";
 *
 * All components:
 * - Accept `height` (px) and optional `className` props
 * - Fill 100% of container width — never cause horizontal scroll
 * - Are theme-aware (light + dark) via CSS variables defined in playful-app.css
 * - Accept an optional `loading` prop that overlays a shimmer animation
 * - Are pure SVG + CSS — no chart libraries
 */

export { PfLinePlaceholder } from "./PfLinePlaceholder";
export type { PfLinePlaceholderProps } from "./PfLinePlaceholder";

export { PfBarsPlaceholder } from "./PfBarsPlaceholder";
export type { PfBarsPlaceholderProps } from "./PfBarsPlaceholder";

export { PfCandlePlaceholder } from "./PfCandlePlaceholder";
export type { PfCandlePlaceholderProps } from "./PfCandlePlaceholder";

export { PfTradingViewPlaceholder } from "./PfTradingViewPlaceholder";
export type { PfTradingViewPlaceholderProps } from "./PfTradingViewPlaceholder";

export { PfPiePlaceholder } from "./PfPiePlaceholder";
export type { PfPiePlaceholderProps } from "./PfPiePlaceholder";

export { PfSparkPlaceholder } from "./PfSparkPlaceholder";
export type { PfSparkPlaceholderProps } from "./PfSparkPlaceholder";

export { PfTextPlaceholder } from "./PfTextPlaceholder";
export type { PfTextPlaceholderProps } from "./PfTextPlaceholder";

export { PfTreemapPlaceholder } from "./PfTreemapPlaceholder";
export type { PfTreemapPlaceholderProps } from "./PfTreemapPlaceholder";

// Re-export CSS so consumers can import styles via the barrel if needed:
// import "@/components/playful/placeholders";
import "./placeholders.css";
