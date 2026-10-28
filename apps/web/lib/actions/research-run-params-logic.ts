/**
 * Pure run-parameter sanitizer for `startResearchAction`, extracted from the
 * `"use server"` research action (MONEY-779) so it is unit-testable without
 * pulling in auth / Prisma / pubsub.
 *
 * `extras.assumptions` / `extras.varConfig` are UNTRUSTED objects forwarded
 * from the chat run-path / ResearchModal (the worker stamps them onto
 * compute_dcf / compute_var params RAW). A fat-fingered WACC=50 (5000%) or a
 * 99.9 VaR confidence would otherwise flow straight into the valuation math.
 *
 * `sanitizeAgainstSchema` validates each field INDEPENDENTLY against the object
 * schema's per-field shape and keeps ONLY the fields that pass — dropping any
 * out-of-range / wrong-typed value while preserving in-bounds siblings. Returns
 * the cleaned object, or `undefined` when nothing survives (so the publish
 * spread omits the key and the worker keeps its own defaults). Pure +
 * synchronous; never throws.
 */

/** Minimal structural type for the per-field schema shape we read. The real
 *  Zod object schemas (researchAssumptionsSchema / researchVarConfigSchema)
 *  satisfy this — we only depend on `.shape[key].safeParse(v).success`. */
export interface FieldShapeSchema {
  shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
}

export function sanitizeAgainstSchema<T extends Record<string, unknown>>(
  schema: FieldShapeSchema,
  value: T | undefined
): Partial<T> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    if (fieldSchema.safeParse(raw).success) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? (out as Partial<T>) : undefined;
}
