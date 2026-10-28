/**
 * Research-style → worker `mode` mapping (MONEY-221).
 *
 * Extracted from `app/api/chat/route.ts` into a server-only-free sibling module
 * so the routing contract can be unit-tested against the REAL function without
 * importing the chat route (which drags in the Next runtime + Prisma client).
 * The route imports `mapStyleToMode` from here; this is its single definition.
 *
 * The mapping translates the user's saved research preference into the
 * worker-facing `mode` enum:
 *
 *   - Auto / undefined → undefined: keep the classifier-driven default so we
 *     don't override a user who hasn't expressed an opinion.
 *   - Quick → fast: single-skill plan, ~30s, 1 credit.
 *   - Deep / Comprehensive / Advanced / Custom → advanced: multi-skill plan
 *     (planner trims Custom to the user-pinned skills downstream).
 *
 * @see apps/web/__tests__/chat-tools/research-style-mapping.test.ts
 */

import type { ResearchStyle } from "@usemoney/services/preferences";

/**
 * Translate the user's saved research style into the worker's `mode` enum.
 * Returns `undefined` for Auto (and an unset preference) so the existing
 * classifier-driven fallback continues to apply.
 */
export function mapStyleToMode(
  style: ResearchStyle | undefined
): "fast" | "advanced" | undefined {
  switch (style) {
    case "quick":
      return "fast";
    case "deep":
    case "comprehensive":
    case "advanced":
    case "custom":
      return "advanced";
    case "auto":
    case undefined:
    default:
      return undefined;
  }
}
