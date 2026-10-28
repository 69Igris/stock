/**
 * Research service pure-logic helpers (no Prisma / no I/O).
 *
 * The side-effect-free derivation/aggregation/clamping the LIVE
 * `research.service.ts` runs between its Prisma read and its
 * `ServiceResult` return. Isolated here so each piece is an EXPORTED,
 * unit-testable symbol the real service CALLS — not an inline expression
 * the test has to shadow — and so importing the logic in a test never opens
 * a Prisma/Redis/socket handle (the module imports nothing server-only).
 *
 * MONEY-620 de-shadow: `apps/web/__tests__/services/research-service-edge-cases.test.ts`
 * previously reimplemented every service function against a `MockDB` and
 * asserted the copy ("All external dependencies are reimplemented inline").
 * That copy could not catch a producer-side bug in the real service. The
 * helpers below are now the single source of truth for:
 *   - session list/status/history pagination clamping (the 500-guard);
 *   - progress %, quality-score and report-score display derivation;
 *   - Invalid-Date → safe value coercion for createdAt/completedAt;
 *   - the stuck-session auto-expire derivation;
 *   - the polling task-progress summarizers (size cap + compact salvage).
 *
 * Behaviour is identical, for FINITE/valid inputs, to what previously lived
 * inline in the service. The only intentional differences are defensive:
 *   1. a legitimate `qualityScore` / `reportScore` of `0` is no longer
 *      dropped to `undefined` by a `0 || undefined` truthy collapse;
 *   2. a `NaN` / negative / `> 100` `progress` (a corrupt worker write) is
 *      clamped to `[0,100]` at the producer so the consumer's
 *      `width: ${progress}%` bar can never be `NaN%`;
 *   3. an Invalid-Date `createdAt` can no longer (a) silently dodge the
 *      stuck-session auto-expire via a `NaN` age comparison, nor (b) reach a
 *      consumer's `relativeTime()` / `new Date()` as an un-renderable value.
 *
 * @see apps/web/__tests__/services/research-logic.test.ts
 */

// ---------------------------------------------------------------------------
// Numeric guards
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-untrusted numeric input to a finite integer, or `null`
 * when it can't be (NaN, ±Infinity, non-number). Floats truncate toward zero.
 */
function toFiniteInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Display form of a 0–100 score (qualityScore / reportScore) stored as a
 * nullable number.
 *
 * The bug this replaces: the service used `session.qualityScore || undefined`
 * (and `r.score` was surfaced raw). `0 || undefined === undefined`, so a
 * legitimate worst-case score of **0** was indistinguishable from "no score"
 * and silently vanished from the status/result/history payloads. Quality and
 * recommendation scores are genuinely in `[0,100]`, where `0` is a real,
 * meaningful value (a failed/empty analysis), so dropping it is data loss.
 *
 * Contract: returns the number for any FINITE input (including `0`), and
 * `undefined` only for `null` / `undefined` / `NaN` / `±Infinity` (the last
 * two would otherwise reach a downstream `.toFixed()` / chart axis as a
 * poison value).
 */
export function displayScore(
  value: number | null | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Clamp a research `progress` to a renderable percentage in `[0, 100]`.
 *
 * `progress` is a DB `Int` written by the worker across many code paths
 * (`progress: 5 … 100`, and a computed `15 + (iter-1)*30` /
 * `Math.min(base+exec, 85)`). A crash mid-write, an arithmetic slip, or a
 * corrupt row can leave it `NaN`, negative, or `> 100`. The consumer renders
 * `width: ${Math.max(0, Math.min(100, progress))}%` — but `Math.min(100, NaN)`
 * is `NaN`, so a `NaN` progress produces `width: NaN%` (a broken bar), and
 * `[sessionId]/client.tsx` does `progress ?? 0` which does NOT catch `NaN`.
 * Guarding at the producer means every consumer (web bar, api JSON, mobile)
 * gets a clean `[0,100]` integer.
 *
 * Contract: NaN / non-number / negative / -Infinity → `0`; `> 100` and
 * +Infinity → `100`; floats truncate toward zero. Never throws.
 */
export function clampProgress(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  // ±Infinity map to the natural bounds (a corrupt "over-progress" is 100%,
  // not "not started"); a finite value is truncated then bounded to [0,100].
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// History pagination (the 500-guard)
// ---------------------------------------------------------------------------

/** Default history page size when `pageSize` is omitted/unusable. */
export const DEFAULT_RESEARCH_PAGE_SIZE = 20;
/** Hard ceiling on a single history page (bounds payload + memory). */
export const MAX_RESEARCH_PAGE_SIZE = 100;

export interface ResearchPaginationBounds {
  /** Safe Prisma `skip`: a non-negative integer = (page-1) * pageSize. */
  skip: number;
  /** Safe Prisma `take`: an integer in [1, MAX_RESEARCH_PAGE_SIZE]. */
  take: number;
}

/**
 * Clamp a (page, pageSize) pair into safe Prisma `skip`/`take` bounds for
 * `getResearchHistory`.
 *
 * The bug class this closes (mirrors `clampPagination` for notifications):
 * `getResearchHistory(userId, page, pageSize)` computed `skip = (page-1) *
 * pageSize` and passed `take: pageSize` straight to `prisma.findMany`. The
 * web action defaults are sane, but the params are forwarded verbatim, and a
 * `page`/`pageSize` of `NaN` (`parseInt("abc")`), negative (`?page=-1` →
 * negative skip), or absurd (`?pageSize=1e9`) reaches Prisma. Prisma 5 THROWS
 * on a non-finite or negative `skip`/`take` (`Invalid value … Expected Int`),
 * turning a stray query string into a 500; a huge `take` is an OOM/payload
 * risk. This makes those inputs safe + deterministic.
 *
 * Contract (pure + total, never throws):
 *   - `pageSize`: NaN / ±Infinity / non-number / ≤ 0 → DEFAULT; above MAX is
 *     capped to MAX; floats truncate.
 *   - `page`: NaN / ±Infinity / non-number / < 1 → 1; floats truncate. The
 *     resulting `skip = (page-1) * take` is therefore always ≥ 0.
 */
export function clampResearchPagination(
  page: unknown = 1,
  pageSize: unknown = DEFAULT_RESEARCH_PAGE_SIZE,
): ResearchPaginationBounds {
  const rawSize = toFiniteInt(pageSize);
  const take =
    rawSize === null || rawSize <= 0
      ? DEFAULT_RESEARCH_PAGE_SIZE
      : Math.min(rawSize, MAX_RESEARCH_PAGE_SIZE);

  const rawPage = toFiniteInt(page);
  const safePage = rawPage === null || rawPage < 1 ? 1 : rawPage;

  return { skip: (safePage - 1) * take, take };
}

// ---------------------------------------------------------------------------
// IDOR scope gate
// ---------------------------------------------------------------------------

/**
 * True when `userId` is a non-empty owner id that MUST scope a session
 * lookup/mutation.
 *
 * IDOR (MONEY-286) context: the read/cancel/delete service functions key on a
 * `sessionId` that is exposed in URLs (`/analysis/{sessionId}`) and is
 * therefore guessable/harvestable. Without a `userId` filter, any
 * authenticated user could read another user's research report (portfolio
 * symbols, query text, full analysis) or cancel/delete their session. The fix
 * scopes every lookup to `{ sessionId, userId }`.
 *
 * This predicate is the fail-closed gate: every REAL caller (web action +
 * api route) passes an authenticated, non-empty `userId`, so a missing /
 * empty userId is never a legitimate request — it is treated as
 * "unauthorized → not found", NOT as a licence to fall through to a bare,
 * cross-user `findUnique({ sessionId })`. Returning `false` here makes the
 * service refuse the unscoped path entirely.
 */
export function isOwnerScoped(userId: string | null | undefined): boolean {
  return typeof userId === "string" && userId.length > 0;
}

// ---------------------------------------------------------------------------
// Invalid-Date guards (producer-side)
// ---------------------------------------------------------------------------

/** True when `d` is a usable, finite calendar date (not Invalid Date / null). */
export function isValidDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * Coerce a stored date to a safe `Date | undefined`: a valid Date is returned
 * as-is; `null` / `undefined` / an Invalid Date (`new Date("garbage")`)
 * collapse to `undefined`.
 *
 * Why at the producer: `completedAt` (optional) and `createdAt` flow to a
 * consumer that does `new Date(createdAt)` → `relativeTime()` /
 * `toLocaleDateString()`. An Invalid Date there renders the literal
 * "Invalid Date" and makes every `diffMs` `NaN`. Emitting `undefined` instead
 * lets the consumer fall back cleanly. (`createdAt` is required on the
 * Running/History items, so for those we keep the value but never an Invalid
 * one — see {@link safeCreatedAt}.)
 */
export function toSafeOptionalDate(
  d: Date | null | undefined,
): Date | undefined {
  return isValidDate(d) ? d : undefined;
}

/**
 * Resolve a REQUIRED `createdAt` for a list item: a valid stored date is
 * returned; an Invalid / missing one falls back to `fallback` (the current
 * instant by default) so the wire shape never carries an un-renderable Date.
 * Pure given an explicit `fallback`.
 */
export function safeCreatedAt(
  d: Date | null | undefined,
  fallback: Date = new Date(),
): Date {
  return isValidDate(d) ? d : fallback;
}

// ---------------------------------------------------------------------------
// Stuck-session auto-expire derivation
// ---------------------------------------------------------------------------

/** Sessions still "running" after this age are treated as orphaned. */
export const STUCK_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

/** Minimal shape the stuck-session derivation needs from a session row. */
export interface AgeableSession {
  sessionId: string;
  createdAt: Date | null | undefined;
}

/**
 * Partition running sessions into those that are orphaned (older than
 * {@link STUCK_SESSION_MAX_AGE_MS}) and those still legitimately active, given
 * the current instant `now`.
 *
 * The worker's hard timeout is ~9 min, so anything still "running" after 15
 * min is orphaned (worker crashed, Pub/Sub never delivered, …) and must be
 * flipped to FAILED. The bug this fixes: the inline version did
 * `now - s.createdAt.getTime() > MAX_AGE`. For an Invalid-Date `createdAt`,
 * `getTime()` is `NaN`, `now - NaN` is `NaN`, and `NaN > MAX_AGE` is `false`
 * — so a corrupt-dated session that is *genuinely* stuck would NEVER auto-
 * expire and would linger as "running" forever (and its Invalid Date would
 * also reach the consumer). Here, a session whose `createdAt` is invalid is
 * treated as stuck (age unknowable ⇒ fail safe by expiring it), and a valid
 * date uses the real age. Pure: `now` is injected.
 *
 * @returns `stuckIds` (to flip to FAILED) and `activeIds` (still running).
 */
export function deriveStuckSessions<T extends AgeableSession>(
  sessions: readonly T[],
  now: Date = new Date(),
): { stuck: T[]; active: T[] } {
  const nowMs = now.getTime();
  const stuck: T[] = [];
  const active: T[] = [];
  for (const s of sessions) {
    const isStuck =
      !isValidDate(s.createdAt) ||
      nowMs - s.createdAt.getTime() > STUCK_SESSION_MAX_AGE_MS;
    (isStuck ? stuck : active).push(s);
  }
  return { stuck, active };
}

// ---------------------------------------------------------------------------
// Report insight extraction (recommendation + investment score)
// ---------------------------------------------------------------------------

/** A normalised view of the recommendation + score embedded in a report JSON. */
export interface ReportInsights {
  recommendation?: string;
  /** Investment recommendation score (0-100) — `undefined` when absent/non-finite. */
  reportScore?: number;
}

/**
 * Extract `{ recommendation, reportScore }` from a stored research `report`
 * JSON blob (whose shape varies across L1–L4 generators).
 *
 * Shapes seen in the wild:
 *   - `{ recommendation, score }`
 *   - `{ content: { recommendation, score } }`
 *   - `{ segments: [...], score? }` (top-level score)
 * Top-level fields win over nested `content.*`.
 *
 * Hardening vs the inline version: a `score` of `NaN`/`Infinity` (corrupt
 * report) passed `typeof r.score === "number"` and was surfaced raw into
 * `reportScore`, then on into a UI `.toFixed()` / scorecard. It is now run
 * through {@link displayScore} so only a finite score survives. Pure & total
 * for any `unknown` input (a non-object report → empty insights).
 */
export function extractReportInsights(report: unknown): ReportInsights {
  const out: ReportInsights = {};
  if (!report || typeof report !== "object") return out;

  const r = report as Record<string, unknown>;
  if (typeof r.recommendation === "string") {
    out.recommendation = r.recommendation;
  }
  if (typeof r.score === "number") {
    out.reportScore = displayScore(r.score);
  }

  if (r.content && typeof r.content === "object") {
    const c = r.content as Record<string, unknown>;
    if (
      out.recommendation === undefined &&
      typeof c.recommendation === "string"
    ) {
      out.recommendation = c.recommendation;
    }
    if (out.reportScore === undefined && typeof c.score === "number") {
      out.reportScore = displayScore(c.score);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Polling task-progress summarizers (size cap + compact salvage)
// ---------------------------------------------------------------------------

/**
 * Per-task result-payload size cap (bytes of JSON). Delta delivery sends each
 * task's data only once, so this can be generous; it exists purely to bound a
 * single pathological tool output.
 */
export const MAX_RESULT_JSON_SIZE = 51200;

/** Tools whose output is delivered separately (as the full report), not summarised. */
export const SKIP_SUMMARY_TOOLS: ReadonlySet<string> = new Set([
  "synthesize_report",
  "compare_stocks",
  "generate_summary",
]);

/**
 * #215a — compact-summary fallback. When full task data exceeds the size cap
 * and can't be reduced by array-slicing, salvage a renderable subset (top-level
 * primitives + short sliced arrays) instead of returning `null` (which made the
 * live stream card render completed-but-empty). Keeps real values (RSI, trend,
 * the first N rows) visible for a very wide payload.
 */
export function compactSummarize(
  data: Record<string, unknown>,
): unknown | null {
  // Skip a single primitive that's itself enormous (a giant prose blob) —
  // keeping it would blow the whole budget on one low-signal field.
  const MAX_PRIMITIVE_LEN = 2000;
  const out: Record<string, unknown> = {};
  // 1) Keep top-level primitives (cheap, high signal) except oversized strings.
  for (const [key, value] of Object.entries(data)) {
    if (
      value == null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    } else if (typeof value === "string" && value.length <= MAX_PRIMITIVE_LEN) {
      out[key] = value;
    }
  }
  // 2) Add back nested objects/arrays one at a time, as long as the running
  //    total stays under the cap. Arrays are sliced progressively.
  for (const [key, value] of Object.entries(data)) {
    if (value == null || typeof value !== "object") continue;
    let candidate: unknown = value;
    if (Array.isArray(value)) {
      for (let len = Math.min(value.length, 12); len >= 1; len--) {
        const sliced = value.slice(0, len);
        if (JSON.stringify(sliced).length <= MAX_RESULT_JSON_SIZE / 2) {
          candidate = sliced;
          break;
        }
        if (len === 1) candidate = null; // even one entry is too big
      }
    }
    if (candidate == null) continue;
    const trial = { ...out, [key]: candidate };
    if (JSON.stringify(trial).length <= MAX_RESULT_JSON_SIZE) {
      out[key] = candidate;
    }
  }
  if (Object.keys(out).length === 0) return null;
  // Final safety: never emit a payload over the cap (many medium strings).
  const keys = Object.keys(out);
  while (keys.length > 0 && JSON.stringify(out).length > MAX_RESULT_JSON_SIZE) {
    delete out[keys.pop() as string];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Cap an arbitrary value to {@link MAX_RESULT_JSON_SIZE} JSON bytes, salvaging where possible. */
export function truncateToSize(data: unknown): unknown {
  const json = JSON.stringify(data);
  // JSON.stringify(undefined) is `undefined` (not a string); treat as nothing.
  if (json === undefined) return null;
  if (json.length <= MAX_RESULT_JSON_SIZE) return data;
  // Oversized array → progressively reduce.
  if (Array.isArray(data)) {
    for (let len = Math.min(data.length, 20); len >= 1; len--) {
      const sliced = data.slice(0, len);
      if (JSON.stringify(sliced).length <= MAX_RESULT_JSON_SIZE) {
        return sliced;
      }
    }
    return null; // a single entry is still oversized
  }
  // #215a — oversized non-array object → salvage a compact subset.
  if (typeof data === "object" && data !== null) {
    return compactSummarize(data as Record<string, unknown>);
  }
  return null;
}

/**
 * Summarise one completed task's result for delivery to the polling client.
 * `null` result, or a SKIP_SUMMARY_TOOLS tool (its output ships as the full
 * report), yields `null`; otherwise the full data, only size-capped. Pure.
 */
export function summarizeTaskResult(
  tool: string,
  result: unknown,
): unknown | null {
  if (!result) return null;
  if (SKIP_SUMMARY_TOOLS.has(tool)) return null;
  return truncateToSize(result);
}

// ---------------------------------------------------------------------------
// Task-progress projection (from the stored plan JSON)
// ---------------------------------------------------------------------------

export interface TaskProgressItem {
  id: string;
  tool: string;
  type: string;
  status: string;
  durationMs?: number;
  resultSummary?: unknown;
}

/**
 * Project the `plan.tasks[]` JSON of a session into the wire `TaskProgressItem[]`
 * the status polling endpoint returns, attaching a `resultSummary` only for
 * completed tasks the client has not already received (delta delivery).
 *
 * Extracted from `getResearchStatus` so the (previously inline) plan-shape
 * parsing + delta gate is a real, asserted export. Tolerates a missing/malformed
 * plan (no `tasks` array → `[]`). Pure: no I/O.
 */
export function buildTaskProgress(
  plan: unknown,
  completedTaskIds?: readonly string[],
): TaskProgressItem[] {
  const planObj = (plan ?? null) as Record<string, unknown> | null;
  const tasks = (planObj?.tasks as Array<Record<string, unknown>>) || [];
  if (!Array.isArray(tasks)) return [];
  const alreadyReceived = new Set(completedTaskIds || []);

  return tasks.map((t) => {
    const id = t.id as string;
    const status = t.status as string;
    const durationMs =
      typeof t.durationMs === "number" &&
      Number.isFinite(t.durationMs) &&
      t.durationMs > 0
        ? t.durationMs
        : undefined;
    const item: TaskProgressItem = {
      id,
      tool: t.tool as string,
      type: t.type as string,
      status,
      durationMs,
    };

    if (status === "completed" && !alreadyReceived.has(id) && t.result) {
      item.resultSummary = summarizeTaskResult(t.tool as string, t.result);
    }

    return item;
  });
}
