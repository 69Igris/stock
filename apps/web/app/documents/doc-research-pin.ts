/**
 * MONEY-396 — Document Vault → Research pin URL.
 *
 * Pure helper extracted from DocumentCard's `handleResearchPin` so the URL
 * contract (route + encoded prompt + forwarded docId) is unit-testable.
 * DocumentCard imports and pushes this; the test asserts the same function.
 */

/**
 * Build the /stocksage URL that seeds a research prompt from a pinned document
 * and forwards its id so the chat composer can hydrate it. Both the title (in
 * the prompt) and the id are URL-encoded so the route stays well-formed for any
 * input (slashes, ampersands, quotes).
 */
export function buildDocResearchPinUrl(doc: {
  id: string;
  title: string;
}): string {
  const prompt = `Use my pinned document "${doc.title}" to inform this research.`;
  return `/stocksage?prompt=${encodeURIComponent(prompt)}&docId=${encodeURIComponent(doc.id)}`;
}
