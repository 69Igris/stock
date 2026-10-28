/**
 * Pure logic for invite-token actions (extracted from invites.ts).
 *
 * Holds the DB-record → API-shape serialization, create-input validation,
 * the Prisma create-data builder, and the active toggle used by the invite
 * server actions. Extracted so they can be unit tested without importing the
 * action (which drags Prisma + Clerk + nanoid). The actions in invites.ts
 * call these helpers.
 *
 * @see apps/admin/__tests__/actions/invites.test.ts
 */

export interface InviteTokenData {
  id: string;
  token: string;
  planId: string;
  discountId: string | null;
  discountCode: string | null;
  maxUses: number;
  usedCount: number;
  usedBy: string[];
  assignedTo: string | null;
  expiresAt: string | null;
  createdBy: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInviteInput {
  planId: string;
  maxUses: number;
  assignedTo?: string;
  expiresAt?: string;
  discountId?: string;
  discountCode?: string;
}

/**
 * Raw DB invite-token record (subset of the Prisma `InviteToken` model used by
 * serialization). Date fields are `Date`; they are converted to ISO strings.
 */
export interface RawInviteToken {
  id: string;
  token: string;
  planId: string;
  discountId: string | null;
  discountCode: string | null;
  maxUses: number;
  usedCount: number;
  usedBy: string[];
  assignedTo: string | null;
  expiresAt: Date | null;
  createdBy: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Serializes a raw DB invite-token record into the API shape.
 * Converts Date objects to ISO strings.
 */
export function serializeInviteToken(t: RawInviteToken): InviteTokenData {
  return {
    id: t.id,
    token: t.token,
    planId: t.planId,
    discountId: t.discountId,
    discountCode: t.discountCode,
    maxUses: t.maxUses,
    usedCount: t.usedCount,
    usedBy: t.usedBy,
    assignedTo: t.assignedTo,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    createdBy: t.createdBy,
    isActive: t.isActive,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * Validates create-invite-token input.
 * Returns the error message when invalid, or null when valid.
 */
export function validateCreateInviteInput(
  data: Partial<CreateInviteInput>,
): string | null {
  if (!data.planId || !data.maxUses) {
    return "planId and maxUses are required";
  }
  return null;
}

/**
 * Builds the Prisma create-data from input, a generated token, and the
 * creating admin's user id.
 */
export function buildInviteCreateData(
  data: CreateInviteInput,
  token: string,
  userId: string,
): Record<string, unknown> {
  return {
    token,
    planId: data.planId,
    maxUses: data.maxUses,
    assignedTo: data.assignedTo || null,
    expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    discountId: data.discountId || null,
    discountCode: data.discountCode || null,
    createdBy: userId,
  };
}

/**
 * Toggles isActive on an invite token.
 */
export function toggleActive(current: boolean): boolean {
  return !current;
}
