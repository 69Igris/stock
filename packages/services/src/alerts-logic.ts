/**
 * Alert validation + patch-building — pure logic (no Prisma).
 *
 * Extracted from `apps/web/lib/actions/alerts.ts` so the enum allow-lists, the
 * channel sanitiser, the cooldown default, and the partial-update builder are
 * testable in isolation and shared by the web action and the API service.
 *
 * @see packages/services/src/alerts.service.ts
 * @see packages/services/__tests__/alerts-service.test.ts
 */

export type AlertKind =
  | "PRICE"
  | "VOLUME"
  | "NEWS"
  | "EARNINGS_DATE"
  | "CORPORATE_ACTION"
  | "CUSTOM"
  | "FLAG_TRANSITION"
  | "DELIVERY_SPIKE"
  | "PLEDGE_INCREASE"
  | "INSIDER_CLUSTER"
  | "MWPL_HIGH"
  | "FII_FLOW_STREAK";

export type AlertStatus = "ACTIVE" | "PAUSED" | "TRIGGERED" | "EXPIRED";

export type NotifyChannel = "IN_APP" | "EMAIL" | "PUSH";

export const VALID_KINDS = new Set<AlertKind>([
  "PRICE",
  "VOLUME",
  "NEWS",
  "EARNINGS_DATE",
  "CORPORATE_ACTION",
  "CUSTOM",
  // MONEY-1204 / 14e.3 — data-engine alert kinds. These read PRECOMPUTED
  // tables only (StockFlag, DailyPrice, ShareholdingPattern, InsiderEvent,
  // MwplDaily, InstitutionalFlow); nothing here scrapes.
  //
  // NOTE: this list is duplicated in three places that do not import each
  // other -- here, apps/web/lib/actions/alerts.ts, and the zod enum in
  // apps/api/src/routes/v1/alerts.ts. Adding a kind to one and not the
  // others makes it creatable on one surface and rejected on another.
  "FLAG_TRANSITION",
  "DELIVERY_SPIKE",
  "PLEDGE_INCREASE",
  "INSIDER_CLUSTER",
  "MWPL_HIGH",
  "FII_FLOW_STREAK",
]);

export const VALID_CHANNELS = new Set<NotifyChannel>([
  "IN_APP",
  "EMAIL",
  "PUSH",
]);

export const VALID_STATUSES = new Set<AlertStatus>([
  "ACTIVE",
  "PAUSED",
  "TRIGGERED",
  "EXPIRED",
]);

/** Default cooldown between fires (minutes) when unset / non-positive. */
export const DEFAULT_COOLDOWN_MINUTES = 60;

export function isValidKind(kind: unknown): kind is AlertKind {
  return typeof kind === "string" && VALID_KINDS.has(kind as AlertKind);
}

export function isValidStatus(status: unknown): status is AlertStatus {
  return (
    typeof status === "string" && VALID_STATUSES.has(status as AlertStatus)
  );
}

/**
 * Keep only recognised channels; default to `["IN_APP"]` when the input is
 * empty / absent (mirrors the web action).
 */
export function sanitizeChannels(
  channels?: NotifyChannel[] | null,
): NotifyChannel[] {
  if (!Array.isArray(channels) || channels.length === 0) return ["IN_APP"];
  const clean = channels.filter((c) => VALID_CHANNELS.has(c));
  return clean.length > 0 ? clean : ["IN_APP"];
}

/** A positive integer cooldown, defaulting to {@link DEFAULT_COOLDOWN_MINUTES}. */
export function normalizeCooldown(minutes?: number): number {
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? Math.floor(minutes)
    : DEFAULT_COOLDOWN_MINUTES;
}

/** The fields a partial update may touch (route-validated). */
export interface AlertUpdateInput {
  status?: AlertStatus;
  conditions?: Record<string, unknown>;
  notifyChannels?: NotifyChannel[];
  cooldownMinutes?: number;
}

/** The sanitised, sparse patch applied to `prisma.alert.update`'s `data`. */
export interface AlertUpdatePatch {
  status?: AlertStatus;
  conditions?: Record<string, unknown>;
  notifyChannels?: NotifyChannel[];
  cooldownMinutes?: number;
}

/**
 * Build the sparse update patch: only provided fields are set, an invalid
 * `status` is dropped, channels are sanitised, and a numeric cooldown is
 * floored (0/negative is preserved verbatim here — the service uses this for a
 * PATCH where an explicit value is intentional).
 */
export function buildAlertUpdatePatch(
  input: AlertUpdateInput,
): AlertUpdatePatch {
  const patch: AlertUpdatePatch = {};
  if (isValidStatus(input.status)) patch.status = input.status;
  if (input.conditions && typeof input.conditions === "object") {
    patch.conditions = input.conditions;
  }
  if (input.notifyChannels) {
    patch.notifyChannels = sanitizeChannels(input.notifyChannels);
  }
  if (typeof input.cooldownMinutes === "number") {
    patch.cooldownMinutes = input.cooldownMinutes;
  }
  return patch;
}
