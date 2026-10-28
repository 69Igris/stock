/**
 * Pure helpers for the admin audit ledger (AdminAuditLog) — MONEY-867.
 *
 * No Prisma/network deps so this is trivially unit-testable; the actual write
 * lives in admin-audit.service.ts (recordAdminAction). Mirrors the established
 * `*-logic.ts` (pure) + `*.service.ts` (prisma) split (see coupon-logic.ts).
 */

export interface AdminActionInput {
  /** Email of the admin performing the action (from the requireAdmin context). */
  actorEmail: string;
  /** Dotted action name, e.g. "coupon.create", "subscription.switchPlan". */
  action: string;
  /** The model/entity acted on, e.g. "Coupon", "User", "Payment". */
  targetType: string;
  /** id / code / email identifying the target (optional). */
  targetId?: string | null;
  /** Params or before/after snapshot (optional). */
  diff?: unknown;
}

export interface AdminAuditEntry {
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  /** Omitted (key absent) when no diff is supplied — never written as raw null. */
  diff?: unknown;
}

/**
 * Normalize an {@link AdminActionInput} into the row shape written to
 * AdminAuditLog:
 * - `targetId` defaults to `null`
 * - `diff` is OMITTED when null/undefined (it is a `Json?` column; raw `null`
 *   has special Prisma semantics, so we leave the key absent instead). Falsy
 *   but present values (`0`, `false`, `""`) are preserved.
 */
export function buildAdminAuditEntry(input: AdminActionInput): AdminAuditEntry {
  const entry: AdminAuditEntry = {
    actorEmail: input.actorEmail,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
  };
  if (input.diff != null) {
    entry.diff = input.diff;
  }
  return entry;
}
