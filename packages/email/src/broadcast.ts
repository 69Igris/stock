import type { ReactElement } from "react";
import { getResendClient } from "./client";
import { EMAIL_FROM, EMAIL_REPLY_TO } from "./constants";
import {
  RESEND_AUDIENCE_FREE_ID,
  RESEND_AUDIENCE_PAID_ID,
  RESEND_AUDIENCE_DOWNGRADED_ID,
  RESEND_AUDIENCE_USEMONEY_SECURITY_ID,
  RESEND_AUDIENCE_MARKETING_ID,
} from "./constants";
import type { Segment } from "./contacts";

interface BroadcastOptions {
  audienceId: string;
  subject: string;
  react: ReactElement;
  name?: string;
}

interface BroadcastResult {
  success: boolean;
  broadcastId?: string;
}

/**
 * Resend rejects a broadcast whose `name` exceeds 70 characters (422
 * validation error). The name is internal-reference only ("Only used for
 * internal reference" per the Resend docs), so truncating is safe.
 *
 * Callers compose the name from the post title — `sendBroadcastToSegments`
 * even appends a ` (downgraded)` suffix (13 chars) — so a longer-titled
 * newsletter overflows 70 and the broadcast silently fails to CREATE, meaning
 * that audience never receives the issue. Clamp at the single choke point
 * (`sendBroadcast`) so every path is covered. (MONEY-1050)
 */
export const RESEND_BROADCAST_NAME_MAX = 70;

export function clampBroadcastName(name?: string): string | undefined {
  if (name == null) return undefined;
  return name.length > RESEND_BROADCAST_NAME_MAX
    ? name.slice(0, RESEND_BROADCAST_NAME_MAX)
    : name;
}

/**
 * Resolve audience ID for a segment. Returns null if not configured.
 */
function getSegmentAudienceId(segment: Segment): string | null {
  let id: string;
  switch (segment) {
    case "free":
      id = RESEND_AUDIENCE_FREE_ID;
      break;
    case "paid":
      id = RESEND_AUDIENCE_PAID_ID;
      break;
    case "downgraded":
      id = RESEND_AUDIENCE_DOWNGRADED_ID;
      break;
    case "usemoney-security":
      id = RESEND_AUDIENCE_USEMONEY_SECURITY_ID;
      break;
    case "marketing":
      id = RESEND_AUDIENCE_MARKETING_ID;
      break;
    default:
      return null;
  }
  return id || null;
}

/**
 * Create a Resend Broadcast and send it immediately.
 * Fire-and-forget: logs errors but never throws.
 */
export async function sendBroadcast(
  options: BroadcastOptions,
): Promise<BroadcastResult> {
  try {
    const resend = getResendClient();

    // Step 1: Create the broadcast
    const { data: createData, error: createError } =
      await resend.broadcasts.create({
        audienceId: options.audienceId,
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        subject: options.subject,
        react: options.react,
        name: clampBroadcastName(options.name),
      });

    if (createError || !createData?.id) {
      console.error(
        "[Resend Broadcast] Failed to create broadcast:",
        createError,
      );
      return { success: false };
    }

    const broadcastId = createData.id;

    // Step 2: Send the broadcast
    const { error: sendError } = await resend.broadcasts.send(broadcastId);

    if (sendError) {
      console.error("[Resend Broadcast] Failed to send broadcast:", sendError);
      return { success: false, broadcastId };
    }

    console.log(
      `[Resend Broadcast] Sent broadcast ${broadcastId}: "${options.subject}"`,
    );
    return { success: true, broadcastId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Resend Broadcast] Error:", message);
    return { success: false };
  }
}

/**
 * Send a broadcast to multiple segments.
 * For each segment, resolves its audience ID and sends a broadcast.
 * Supports per-segment React templates via `buildReact`, or a single `react` element for all.
 * Returns results for each segment.
 */
export async function sendBroadcastToSegments(options: {
  segments: Segment[];
  subject: string;
  react?: ReactElement;
  buildReact?: (segment: Segment) => ReactElement;
  name?: string;
}): Promise<BroadcastResult[]> {
  const results: BroadcastResult[] = [];

  for (const segment of options.segments) {
    const audienceId = getSegmentAudienceId(segment);
    if (!audienceId) {
      console.warn(
        `[Resend Broadcast] Skipping segment "${segment}": audience ID not configured`,
      );
      results.push({ success: false });
      continue;
    }

    const reactElement = options.buildReact
      ? options.buildReact(segment)
      : options.react!;

    const result = await sendBroadcast({
      audienceId,
      subject: options.subject,
      react: reactElement,
      name: options.name
        ? `${options.name} (${segment})`
        : `Newsletter (${segment})`,
    });

    results.push(result);
  }

  return results;
}
