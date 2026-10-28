/**
 * Registry - run_research auto-detection (pure logic)
 *
 * The `run_research` tool's parameter inference + progress message live here so
 * they can be unit-tested without importing the registry (which pulls every
 * server action → `react.cache`). `registry.ts`'s `run_research.execute` imports
 * and calls these, so production and the tests run the SAME inference (no
 * shadow).
 */

export interface ResearchInferred {
  query: string;
  skill: string | undefined;
  mode: "fast" | "advanced";
  symbols: string[] | undefined;
}

/**
 * Infer the research skill / mode / query from the (LLM- or classifier-supplied)
 * params:
 *   - 2+ symbols and no explicit skill → "peer-comparison"
 *   - 2+ symbols and no explicit mode → "advanced" (else "fast")
 *   - query falls back to description, then a generated label from symbols.
 */
export function inferResearchParams(
  params: Record<string, unknown>
): ResearchInferred {
  const symbols = params.symbols as string[] | undefined;
  const isMultiStock = Array.isArray(symbols) && symbols.length > 1;

  const skill =
    (params.skill as string | undefined) ||
    (isMultiStock ? "peer-comparison" : undefined);

  const mode =
    (params.mode as "fast" | "advanced") ||
    (isMultiStock ? "advanced" : "fast");

  const query =
    (params.query as string) ||
    (params.description as string) ||
    (isMultiStock
      ? `Compare ${symbols!.join(" vs ")}`
      : symbols?.[0]
        ? `Analyze ${symbols[0]}`
        : "Stock analysis");

  return { query, skill, mode, symbols };
}

/** The progress message returned when a research run is queued. */
export function buildResearchMessage(mode: "fast" | "advanced"): string {
  return `${mode === "fast" ? "Quick" : "Comprehensive"} research started! I'll update you on progress.`;
}
