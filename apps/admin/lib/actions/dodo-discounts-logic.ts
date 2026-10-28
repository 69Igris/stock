/**
 * Pure logic for the Dodo discounts admin API
 * (apps/admin/app/api/admin/discounts/route.ts).
 *
 * The route's POST handler validates the amount and assembles the Dodo
 * `discounts.create` params inline. That logic is extracted here so it can be
 * unit tested without importing the route (which drags Clerk + the Dodo
 * client). The route handler calls these helpers.
 *
 * @see apps/admin/__tests__/actions/discounts.test.ts
 */

export interface CreateDiscountInput {
  amount: number;
  type?: string;
  code?: string;
  expiresAt?: string;
  usageLimit?: number;
  restrictedTo?: string[];
  name?: string;
}

/**
 * Validates create-discount input.
 * Mirrors the route's `if (!amount || amount <= 0)` guard.
 * Returns the error message when invalid, or null when valid.
 */
export function validateCreateDiscountInput(
  data: Partial<CreateDiscountInput>,
): string | null {
  if (!data.amount || data.amount <= 0) {
    return "amount must be a positive number";
  }
  return null;
}

/**
 * Builds the Dodo `discounts.create` params from the route's request body,
 * applying the same defaulting the route handler uses.
 */
export function buildDodoCreateParams(
  data: CreateDiscountInput,
): Record<string, unknown> {
  return {
    amount: data.amount,
    type: data.type || "percentage",
    code: data.code || undefined,
    expires_at: data.expiresAt || undefined,
    usage_limit: data.usageLimit || undefined,
    restricted_to: data.restrictedTo?.length ? data.restrictedTo : undefined,
    name: data.name || undefined,
  };
}
