/**
 * Pure avatar helpers for the subscriber detail page.
 *
 * Extracted out of the `"use client"` page component so the initials/colour
 * derivation can be unit-tested against the REAL exported symbols instead of
 * inline copies. `page.tsx` imports and calls these.
 *
 * @see apps/content/__tests__/actions/subscribers.test.ts
 */

/** Up-to-2-letter initials from a name, falling back to the email prefix. */
export function getInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  return email.slice(0, 2).toUpperCase();
}

/** Deterministic Tailwind avatar background colour derived from the email. */
export function getAvatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    "bg-blue-600",
    "bg-emerald-600",
    "bg-violet-600",
    "bg-amber-600",
    "bg-rose-600",
    "bg-cyan-600",
    "bg-pink-600",
    "bg-indigo-600",
  ];
  return colors[Math.abs(hash) % colors.length] ?? "bg-blue-600";
}
