/**
 * Attach a request id, and echo it back — but NEVER on a response the CDN may
 * share between callers.
 *
 * Honours an inbound `x-request-id` so a trace started at the load balancer or
 * in `apps/web` stays one identity across the hop. Without that, every request
 * through this service looks unrelated to the page that made it.
 *
 * ## WHY THE HEADER IS WITHHELD FROM CACHEABLE RESPONSES
 *
 * Cloud CDN stores the ORIGIN's headers and replays them on every hit. This
 * middleware used to set the id before `next()`, so `/udf/config` — the most
 * cacheable route here, `public, max-age=3600` — carried ONE requester's id for
 * an hour, handed to everyone who asked. That is worse than no header: it is
 * not merely stale, it correlates a reader's request to a stranger's, on
 * exactly the routes this service exists to make cacheable.
 *
 * So the decision is made AFTER the handler, when the `Cache-Control` it chose
 * is readable. The id is still set on the context, so the origin's own log line
 * carries it either way — what is dropped is the claim to the CALLER that this
 * response is theirs.
 */
import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Does this `Cache-Control` let a SHARED cache store the response?
 *
 * `public` and `s-maxage` both do. A bare `max-age` is deliberately NOT here —
 * it permits a private browser cache, which is per-caller and cannot mix two
 * callers' ids. `private` and `no-store` are not shared by definition.
 */
export function isSharedCacheable(
  cacheControl: string | null | undefined,
): boolean {
  if (!cacheControl) return false;
  const value = cacheControl.toLowerCase();
  if (value.includes("no-store") || value.includes("private")) return false;
  return value.includes("public") || value.includes("s-maxage");
}

export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  // A caller-supplied id is echoed but never trusted for anything but
  // correlation — it is attacker-controlled and must not reach a query.
  const id = inbound && inbound.length <= 200 ? inbound : randomUUID();
  c.set("requestId", id);

  await next();

  if (!isSharedCacheable(c.res.headers.get("cache-control"))) {
    c.res.headers.set(REQUEST_ID_HEADER, id);
  }
};
