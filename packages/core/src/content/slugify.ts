/**
 * Slug generation and validation utilities for content URLs
 */

/**
 * Generate a URL-safe slug from a string
 */
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove special characters
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Remove consecutive hyphens
    .replace(/^-|-$/g, ""); // Remove leading/trailing hyphens
}

/**
 * Ensure slug is unique by appending a number if needed
 * @param slug - The base slug
 * @param existingSlugs - Array of existing slugs to check against
 */
export function ensureUniqueSlug(
  slug: string,
  existingSlugs: string[],
): string {
  if (!existingSlugs.includes(slug)) return slug;

  let counter = 1;
  let newSlug = `${slug}-${counter}`;
  while (existingSlugs.includes(newSlug)) {
    counter++;
    newSlug = `${slug}-${counter}`;
  }
  return newSlug;
}

/**
 * Validate that a string is a valid slug
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
