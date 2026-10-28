/**
 * Reading time calculation utilities for content
 */

const WORDS_PER_MINUTE = 225;

/**
 * Calculate reading time in minutes from text content
 */
export function calculateReadingTime(content: string): number {
  // Strip HTML tags
  const text = content.replace(/<[^>]*>/g, "");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(words / WORDS_PER_MINUTE);
  return Math.max(1, minutes);
}

/**
 * Format reading time for display
 */
export function formatReadingTime(minutes: number): string {
  return `${minutes} min read`;
}

/**
 * Get reading time from BlockNote JSON content
 */
export function getReadingTimeFromBlockNote(content: string): number {
  try {
    const blocks = JSON.parse(content);
    const text = extractTextFromBlocks(blocks);
    return calculateReadingTime(text);
  } catch {
    return 1;
  }
}

export interface BlockContent {
  type: string;
  text?: string;
}

export interface Block {
  content?: BlockContent[];
  children?: Block[];
}

/**
 * Recursively extract plain text from BlockNote blocks.
 * Exported for direct unit testing; the production path reaches it via
 * `getReadingTimeFromBlockNote`.
 */
export function extractTextFromBlocks(blocks: Block[]): string {
  let text = "";
  for (const block of blocks) {
    if (block.content) {
      for (const item of block.content) {
        if (item.type === "text") {
          text += item.text + " ";
        }
      }
    }
    if (block.children) {
      text += extractTextFromBlocks(block.children);
    }
  }
  return text;
}
