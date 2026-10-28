/**
 * NOT_IMPLEMENTED guard for the tRPC surface (MONEY-1062).
 *
 * Every procedure in this package is CURRENTLY an unimplemented stub — the real,
 * implemented API is the REST `/v1` surface in `apps/api/src/routes/v1`. Rather
 * than return fabricated data (hardcoded zeros, `{ id: "" }`, a bare
 * `{ success: true }` that deletes nothing), each procedure calls this so a
 * caller fails loudly with a 501-equivalent (`NOT_IMPLEMENTED`) that names the
 * concrete REST route to use instead.
 *
 * Keep the `.input(...)` schemas + router tree intact so the shape is ready for
 * a future real implementation; only the resolver bodies throw.
 */

import { TRPCError } from "@trpc/server";

/**
 * Always throws a `NOT_IMPLEMENTED` TRPCError naming the REST equivalent.
 *
 * @param restRoute the concrete REST route to use instead, e.g. `"GET /v1/dashboard"`.
 * @returns never — the call site can `return notImplemented(...)` for a `never`
 *   resolver return type.
 */
export function notImplemented(restRoute: string): never {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `Not implemented over tRPC — use the REST /v1 equivalent: ${restRoute}`,
  });
}
