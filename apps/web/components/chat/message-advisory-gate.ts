/**
 * MONEY-501 (SEBI IA Reg 18(9)) — chat advisory-disclaimer gate.
 *
 * Pure logic extracted from MessageRenderer so the gate is unit-testable
 * without rendering the "use client" component. MessageRenderer imports
 * `messageIsAdvisory` to decide whether to render the SEBI AI-advisory footer;
 * the test asserts the same export.
 *
 * A message is advisory (footer required) UNLESS every block is purely an
 * error / refusal / navigation / action-confirmation turn — those carry their
 * own copy and need no SEBI footer.
 */

import type { ContentBlock } from "@usemoney/types";

export const NON_ADVISORY_BLOCK_TYPES = new Set<ContentBlock["type"]>([
  "error",
  "refusal",
  "navigation",
  "action",
]);

/** True when at least one block is advisory content (anything not in the set). */
export function messageIsAdvisory(blocks: ContentBlock[]): boolean {
  return blocks.some((b) => !NON_ADVISORY_BLOCK_TYPES.has(b.type));
}
