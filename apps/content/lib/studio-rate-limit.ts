/**
 * Studio cost guardrail (MONEY-633): per-user daily caps on image generation and
 * reel renders, since Veo + high-res image generation cost real money. Redis-backed
 * daily counters (UTC day). Fails OPEN when Redis is unavailable so local dev / a
 * Redis hiccup never blocks generation — this is a cost guardrail, not auth. Limits
 * are env-overridable (STUDIO_IMAGE_DAILY_LIMIT / STUDIO_REEL_DAILY_LIMIT).
 */
import Redis from "ioredis";

let _redis: Redis | null = null;
function redis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  _redis = new Redis(url, { maxRetriesPerRequest: 3 });
  return _redis;
}

export type StudioAction = "image" | "reel";

const DEFAULTS: Record<StudioAction, number> = { image: 50, reel: 10 };

export function dailyLimit(action: StudioAction): number {
  const raw =
    action === "image"
      ? process.env.STUDIO_IMAGE_DAILY_LIMIT
      : process.env.STUDIO_REEL_DAILY_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS[action];
}

export interface RateResult {
  ok: boolean;
  used: number;
  limit: number;
}

/** Increment + check the user's daily counter for `action`. Fail-open on any Redis issue. */
export async function checkDailyLimit(
  userId: string,
  action: StudioAction,
): Promise<RateResult> {
  const limit = dailyLimit(action);
  const client = redis();
  if (!client) return { ok: true, used: 0, limit };
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `studio:rl:${action}:${userId}:${day}`;
  try {
    const used = await client.incr(key);
    if (used === 1) await client.expire(key, 60 * 60 * 26); // ~1 day + buffer
    return { ok: used <= limit, used, limit };
  } catch {
    return { ok: true, used: 0, limit };
  }
}
