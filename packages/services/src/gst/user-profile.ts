/**
 * Per-user GST profile - used by the domestic invoice engine (MONEY-227)
 * to stamp Indian buyer details onto a UMAI/DOM/YY-YY/NNNN invoice.
 *
 * The profile is OPTIONAL. Users without a saved profile can still pay
 * (and Dodo issues their own receipt), but they cannot download a
 * GST-compliant invoice from us until they fill in at least the legal
 * name + address + state code.
 *
 * GSTIN is itself optional - B2C consumers (most users) won't have one.
 * When GSTIN is absent, the engine produces a regular Tax Invoice with
 * the user's name and PAN; when present, the engine treats the supply
 * as B2B and includes GSTIN on the document.
 */

import { prisma } from "@usemoney/database";
import { z } from "zod";

// GSTIN format: 2-digit state + 10-char PAN + entity number + Z + checksum.
// We validate format only; full checksum verification needs the CBIC API
// which we don't have access to in v1.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][Z][0-9A-Z]$/;

// PAN format: 5 letters + 4 digits + 1 letter, e.g. "ABCDE1234F".
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// GST state codes are 01–37 (Indian states + UTs); first 2 digits of GSTIN.
const STATE_CODE_REGEX = /^(0[1-9]|[12][0-9]|3[0-7])$/;

export const userGstProfileSchema = z.object({
  legalName: z
    .string()
    .trim()
    .min(2, "Legal name must be at least 2 characters")
    .max(120, "Legal name must be ≤120 characters"),
  address: z
    .string()
    .trim()
    .min(10, "Address must include enough detail for a tax document")
    .max(500, "Address must be ≤500 characters"),
  stateCode: z
    .string()
    .trim()
    .regex(STATE_CODE_REGEX, "Invalid GST state code (01–37)"),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN_REGEX, "Invalid GSTIN format")
    .optional()
    .or(z.literal("")),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PAN_REGEX, "Invalid PAN format")
    .optional()
    .or(z.literal("")),
});

export type UserGstProfileInput = z.infer<typeof userGstProfileSchema>;

export interface UserGstProfile extends UserGstProfileInput {
  registeredAt: Date;
  updatedAt: Date;
}

/**
 * Read the GST profile for a user. Returns null when the user hasn't saved
 * one yet - callers must surface the "Add GST details" prompt rather than
 * generating an invoice with placeholder data.
 */
export async function getUserGstProfile(
  userId: string,
): Promise<UserGstProfile | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gstProfile: true },
  });
  if (!user?.gstProfile || typeof user.gstProfile !== "object") {
    return null;
  }
  // Mongo Json round-trip - re-validate at read time so we surface schema
  // drift quickly instead of letting it leak into PDFs.
  const raw = user.gstProfile as Record<string, unknown>;
  const parsed = userGstProfileSchema.safeParse({
    legalName: raw.legalName,
    address: raw.address,
    stateCode: raw.stateCode,
    gstin: raw.gstin || undefined,
    pan: raw.pan || undefined,
  });
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    registeredAt: raw.registeredAt
      ? new Date(raw.registeredAt as string)
      : new Date(),
    updatedAt: raw.updatedAt ? new Date(raw.updatedAt as string) : new Date(),
  };
}

/**
 * Set / update the user's GST profile. Validates with Zod and persists. The
 * `registeredAt` timestamp is only set on first save; subsequent updates
 * touch only `updatedAt`.
 */
export async function setUserGstProfile(
  userId: string,
  input: UserGstProfileInput,
): Promise<UserGstProfile> {
  const parsed = userGstProfileSchema.parse(input);
  const existing = await getUserGstProfile(userId);
  const profile: UserGstProfile = {
    ...parsed,
    gstin: parsed.gstin || undefined,
    pan: parsed.pan || undefined,
    registeredAt: existing?.registeredAt ?? new Date(),
    updatedAt: new Date(),
  };
  await prisma.user.update({
    where: { id: userId },
    data: { gstProfile: profile as unknown as object },
  });
  return profile;
}

/**
 * Clear the profile (admin-only path; users typically just edit it).
 */
export async function clearUserGstProfile(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { gstProfile: null as unknown as never },
  });
}

export const GST_PROFILE_REGEXES = {
  GSTIN: GSTIN_REGEX,
  PAN: PAN_REGEX,
  STATE_CODE: STATE_CODE_REGEX,
};
