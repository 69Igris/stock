/**
 * Pure tier-detection for the /analysis list, extracted from the "use client"
 * page so the skill → tier mapping is unit-testable. client.tsx imports
 * detectTier and uses it for the filter pills (Quick / Deep Dive /
 * Comprehensive / Advanced).
 */

export type AnalysisTier = "L1" | "L2" | "L3" | "L4";

/**
 * Map a research session's `skill` string to its UI tier (per Analysis.jsx).
 * Default is L2 (Deep Dive) when the skill is missing or unrecognised.
 */
export function detectTier(skill?: string): AnalysisTier {
  if (!skill) return "L2";
  if (skill.includes("advanced") || skill === "l4") return "L4";
  if (
    skill.includes("comprehensive") ||
    skill === "peer-comparison" ||
    skill === "l3"
  )
    return "L3";
  if (skill.includes("quick") || skill === "l1") return "L1";
  return "L2";
}
