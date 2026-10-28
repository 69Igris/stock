/**
 * Saved Screens — pure validation + helper logic (MONEY-201).
 *
 * Extracted from the `"use server"` action file
 * (apps/web/lib/actions/saved-screens.ts) so the Zod input schemas and the
 * `countFilters` helper can be unit-tested without booting Clerk + Prisma.
 *
 * The action imports these exact symbols (schemas + helper) and uses them
 * directly — there is NO dead/duplicate copy.
 */

import { z } from "zod";

export const ModeSchema = z.enum(["stocks", "mf", "etf"]);

export const NameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(60, "Name too long (max 60 chars)");

export const SaveSchema = z.object({
  name: NameSchema,
  mode: ModeSchema,
  filters: z.record(z.string(), z.unknown()),
  query: z.string().max(200).optional(),
});

export const RenameSchema = z.object({
  id: z.string().min(1),
  name: NameSchema,
});

/**
 * Count "active" filters in a screener filter bag.
 *
 * Skips the `limit` key (it's paging, not a filter), and treats null /
 * undefined / empty-string / whitespace-string / empty-array as "not set".
 * Numeric `0` is a real filter value (e.g. `minReturns1Y: 0` → "≥ 0%") and is
 * counted.
 */
export function countFilters(filters: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(filters)) {
    if (k === "limit") continue;
    if (v == null) continue;
    if (typeof v === "string" && v.trim().length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n++;
  }
  return n;
}
