"use client";

/**
 * usePasswordStrength — lightweight live password strength meter.
 * Returns a score 0–4 and a label string. No external dep.
 *
 * Scoring:
 *   0 = empty / too short (< 8 chars)
 *   1 = weak  (8+ but only one char class)
 *   2 = fair  (8+ with 2 char classes)
 *   3 = good  (12+ with 2+ char classes, or 8+ with 3 classes)
 *   4 = strong (12+ with all 4 classes)
 */

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

const LABELS: Record<number, string> = {
  0: "",
  1: "Weak — try a longer password.",
  2: "Fair — add a number or symbol.",
  3: "Good — add a symbol for strong.",
  4: "Strong password.",
};

export function getPasswordStrength(password: string): PasswordStrength {
  if (!password || password.length < 8) {
    return { score: 0, label: LABELS[0] };
  }

  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;

  const long = password.length >= 12;

  let score: 0 | 1 | 2 | 3 | 4;
  if (classes === 1) {
    score = 1;
  } else if (classes === 2 && !long) {
    score = 2;
  } else if ((classes === 2 && long) || classes === 3) {
    score = 3;
  } else {
    // classes === 4 or long with 3+
    score = long && classes >= 3 ? 4 : 3;
  }

  return { score, label: LABELS[score] };
}
