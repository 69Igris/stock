/**
 * Request-parsing helpers (MONEY-736)
 *
 * Two small, framework-light guards every write route uses BEFORE touching a
 * service:
 *
 *   - `safeJson(c)`  — parse the request body without letting a malformed body
 *     throw out of the handler (a raw `await c.req.json()` on invalid JSON
 *     rejects and, uncaught, surfaces as a generic 500). The route maps a
 *     `{ ok: false }` result to a 400 `BAD_REQUEST`.
 *   - `zodParse(schema, data)` — run a Zod (or any `safeParse`-shaped) schema and
 *     flatten the failure into `{ ok: false, issues }` the route maps to a 400
 *     with per-field detail, instead of letting `schema.parse` throw.
 *
 * Both return a discriminated `{ ok: true, ... } | { ok: false, ... }` so the
 * call site is a total switch with no try/catch.
 */

import type { Context } from "hono";

/** Result of {@link safeJson}. `ok:false` means the body was not valid JSON. */
export type SafeJsonResult<T = unknown> = { ok: true; data: T } | { ok: false };

/**
 * Parse `c.req.json()` without throwing.
 *
 * A missing/empty/malformed body resolves to `{ ok: false }` (never rejects),
 * so a route can deterministically return a 400 instead of a 500. Note a JSON
 * `null` body IS valid JSON and yields `{ ok: true, data: null }` — schema
 * validation (see {@link zodParse}) is what rejects an unexpected shape.
 */
export async function safeJson<T = unknown>(
  c: Context,
): Promise<SafeJsonResult<T>> {
  try {
    const data = (await c.req.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

/** A single field-level validation problem, flattened from a Zod issue. */
export interface ParseIssue {
  /** Property path to the offending field (`[]` for the root value). */
  path: (string | number)[];
  /** Human-readable message. */
  message: string;
}

/** Result of {@link zodParse}. */
export type ZodParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: ParseIssue[] };

/**
 * Structural view of the part of a Zod schema {@link zodParse} depends on.
 *
 * Typed structurally (rather than importing `zod`) so `@usemoney/api-utils`
 * stays dependency-light — any object exposing a Zod-compatible `safeParse`
 * works.
 */
export interface SafeParseable<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<ParseIssue> } };
}

/**
 * Validate `data` against a `safeParse`-shaped schema, flattening a failure into
 * `{ ok: false, issues }` (never throws). The route maps `issues` into the
 * `details` of a 400 response.
 */
export function zodParse<T>(
  schema: SafeParseable<T>,
  data: unknown,
): ZodParseResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: [...issue.path],
      message: issue.message,
    })),
  };
}
