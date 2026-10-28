/**
 * Soft page-render timeout — MONEY-1126.
 *
 * Server components warm-load their data so the client doesn't have to (see
 * `app/holdings/page.tsx`, `app/dashboard/page.tsx`), but a slow query must
 * never hold the whole document hostage: past the deadline we ship the page
 * with `null` and let the client hydrate the rest.
 *
 * The version this replaces was `Promise.race([p, new Promise(r =>
 * setTimeout(r, ms))])` with no `clearTimeout`. When `p` won the race — the
 * common case — the timer stayed armed for the full `ms`, so every render of
 * those pages left pending handles behind (and a test importing the page would
 * hang past its assertions). Clearing in a `finally` bounds the handle to the
 * shorter of "settled" and "deadline".
 *
 * What it does NOT do: abort the losing work. `p` keeps running to completion
 * — there is no cancellation token on a Prisma query — we just stop waiting.
 * Pass a promise that cannot reject (`.catch(() => null)`) if a rejection
 * arriving AFTER the deadline would otherwise be unhandled.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });

  return Promise.race<T | null>([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
