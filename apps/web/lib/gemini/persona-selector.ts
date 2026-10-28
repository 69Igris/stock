/**
 * Persona Selector
 *
 * Two-phase persona selection:
 * 1. Fast path: keyword matching from persona triggerKeywords (~80% of queries)
 * 2. Flash path: resolved alongside intent classification (no extra LLM call)
 *
 * The selector returns a personaId which is used to compose the system prompt.
 */

// Import persona DATA directly (not the barrel) so this selector stays free of
// the server-only `@/lib/chat-tools` chain that composeSystemPrompt pulls in.
import {
  PERSONAS,
  type PersonaId,
  type ExpertPersona,
} from "./prompt-personas-data";

export interface PersonaSelection {
  personaId: PersonaId;
  confidence: number;
  source: "keyword" | "flash" | "default";
}

/**
 * Fast-path persona selection using keyword matching.
 * Checks each persona's triggerKeywords against the normalized message.
 * Returns the persona with the most keyword matches.
 */
export function selectPersonaFast(message: string): PersonaSelection | null {
  const normalized = message.toLowerCase().trim();

  let bestMatch: { personaId: PersonaId; matchCount: number } | null = null;

  for (const [id, persona] of Object.entries(PERSONAS) as [
    PersonaId,
    ExpertPersona,
  ][]) {
    if (persona.triggerKeywords.length === 0) continue;

    let matchCount = 0;
    for (const keyword of persona.triggerKeywords) {
      // Use word boundary check for short keywords to avoid false positives
      if (keyword.length <= 3) {
        const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i");
        if (regex.test(normalized)) {
          matchCount++;
        }
      } else if (normalized.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }

    if (matchCount > 0 && (!bestMatch || matchCount > bestMatch.matchCount)) {
      bestMatch = { personaId: id, matchCount };
    }
  }

  if (bestMatch) {
    return {
      personaId: bestMatch.personaId,
      confidence: Math.min(0.6 + bestMatch.matchCount * 0.1, 0.95),
      source: "keyword",
    };
  }

  return null;
}

/**
 * Resolve persona from Flash classification result.
 * Called when the intent mapper's Flash call returns a persona field.
 */
export function selectPersonaFromFlash(
  flashPersona: string | undefined
): PersonaSelection | null {
  if (!flashPersona) return null;

  // Validate the persona ID
  if (flashPersona in PERSONAS) {
    return {
      personaId: flashPersona as PersonaId,
      confidence: 0.85,
      source: "flash",
    };
  }

  return null;
}

/**
 * Unified persona selector - tries fast path first, returns default if no match.
 * Flash-based selection is handled externally (via intent mapper response)
 * and merged in the chat route.
 */
export function selectPersona(
  message: string,
  flashPersona?: string
): PersonaSelection {
  // 1. If Flash already classified the persona, use it
  const flashResult = selectPersonaFromFlash(flashPersona);
  if (flashResult) return flashResult;

  // 2. Try keyword fast-path
  const fastResult = selectPersonaFast(message);
  if (fastResult) return fastResult;

  // 3. Default to general analyst
  return {
    personaId: "general_analyst",
    confidence: 0.5,
    source: "default",
  };
}

/**
 * Generate persona-specific bare stock options.
 * Shown when the user mentions a stock without a specific question.
 */
export function getBareStockOptions(symbol: string): string {
  return (
    `What would you like to know about **${symbol}**?\n\n` +
    `- **Equity Research** - Investment score, thesis, key metrics\n` +
    `- **Deep Valuation** - DCF, cash flow quality, earnings analysis\n` +
    `- **Technical Analysis** - RSI, MACD, support/resistance levels\n` +
    `- **Peer Comparison** - Head-to-head with sector peers\n` +
    `- **Latest News** - Recent headlines and developments\n\n` +
    `Or ask anything specific about ${symbol}.`
  );
}

// ============== Helpers ==============

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
