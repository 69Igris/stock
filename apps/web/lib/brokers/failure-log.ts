/**
 * Broker Integration Failure Log — MONEY-502 (ZA-4).
 *
 * Structured, queryable persistence for every broker (Zerodha) integration
 * failure, feeding the Jun-20 Zerodha-audit "last N failures by error_class"
 * report. Writes are FIRE-AND-FORGET — a logging-DB hiccup must never break a
 * sync or change control flow, so `recordBrokerFailure` swallows its own errors
 * and callers do not await it.
 *
 * PII-minimisation: the internal `user.id` is sha256-hashed before persistence
 * (never the raw id / email / clerkId), consistent with the data-minimisation
 * commitments.
 *
 * Capture sites: broker READS all funnel through `base-client.ts makeRequest`,
 * but that transport layer has no `userId` in scope — so reads are recorded at
 * the SYNC layer (`broker-connection.ts` per-operation catches), which already
 * wraps every read with the right operation name + user. OAuth/token-exchange
 * failures are recorded at the OAuth-callback catch. base-client.ts is left
 * unchanged by design.
 */

import crypto from "node:crypto";
import prisma from "@/lib/prisma";
import type { BrokerType } from "@usemoney/types";
import { syncLogger } from "@usemoney/logger";
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";
import { mapKnownBrokerError } from "./known-errors";

export type BrokerErrorClass =
  | "AUTH_EXPIRED"
  | "USER_NOT_ENABLED"
  | "RATE_LIMIT"
  | "NETWORK"
  | "UPSTREAM_5XX"
  | "VALIDATION"
  | "UNKNOWN";

export interface ClassifiedBrokerError {
  errorClass: BrokerErrorClass;
  errorCode?: string;
  recoveryAction?: string;
}

/**
 * Map a raw broker error message to a stable {errorClass, errorCode,
 * recoveryAction} so failures can be grouped. Pure + side-effect-free so it is
 * unit-testable without the DB.
 */
export function classifyBrokerError(raw: string): ClassifiedBrokerError {
  const msg = (raw || "").toLowerCase();

  // Reuse the existing known-error matcher first (Zerodha whitelist case).
  const known = mapKnownBrokerError(raw);
  if (known?.code === "ZERODHA_USER_NOT_ENABLED") {
    return {
      errorClass: "USER_NOT_ENABLED",
      errorCode: known.code,
      recoveryAction: "switch_broker",
    };
  }

  // Extract an HTTP status if present (e.g. "ZERODHA API Error: 403 - ...").
  const statusMatch = raw.match(/API Error:\s*(\d{3})/);
  const status = statusMatch ? parseInt(statusMatch[1]!, 10) : undefined;
  const httpCode = status ? `HTTP_${status}` : undefined;

  if (
    status === 401 ||
    msg.includes("token") ||
    msg.includes("session") ||
    msg.includes("expired") ||
    msg.includes("unauthor")
  ) {
    return {
      errorClass: "AUTH_EXPIRED",
      errorCode: httpCode,
      recoveryAction: "reauth",
    };
  }
  if (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("too many")
  ) {
    return {
      errorClass: "RATE_LIMIT",
      errorCode: httpCode ?? "HTTP_429",
      recoveryAction: "retry",
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      errorClass: "UPSTREAM_5XX",
      errorCode: httpCode,
      recoveryAction: "retry",
    };
  }
  if (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  ) {
    return {
      errorClass: "NETWORK",
      errorCode: httpCode,
      recoveryAction: "retry",
    };
  }
  if (status === 400 || msg.includes("invalid") || msg.includes("validation")) {
    return { errorClass: "VALIDATION", errorCode: httpCode ?? "HTTP_400" };
  }
  return { errorClass: "UNKNOWN", errorCode: httpCode };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Record a broker integration failure. FIRE-AND-FORGET: callers do NOT await
 * this and it never throws — a logging failure must not break a sync.
 * `userId` is the internal `user.id` (hashed here); pass "" if unavailable
 * (records an anonymous failure rather than dropping it).
 */
export async function recordBrokerFailure(params: {
  userId: string;
  broker: BrokerType;
  operation: string;
  error: unknown;
  claudeSessionId?: string;
}): Promise<void> {
  try {
    const raw =
      params.error instanceof Error
        ? params.error.message
        : String(params.error ?? "");
    const { errorClass, errorCode, recoveryAction } = classifyBrokerError(raw);
    await prisma.brokerIntegrationFailure.create({
      data: {
        userIdHash: sha256(params.userId || "anonymous"),
        broker: params.broker,
        operation: params.operation,
        errorClass,
        errorCode: errorCode ?? null,
        userFacingMessage: getSafeErrorMessage(
          params.error,
          "Broker request failed"
        ),
        recoveryAction: recoveryAction ?? null,
        claudeSessionId: params.claudeSessionId ?? null,
        rawMessageHash: raw ? sha256(raw) : null,
      },
    });
  } catch (e) {
    syncLogger.warn({ err: e }, "failed to persist broker integration failure");
  }
}

type FailureRow = Awaited<
  ReturnType<typeof prisma.brokerIntegrationFailure.findMany>
>[number];

/**
 * Last N failures grouped by errorClass with counts + a small sample — the
 * Jun-20 audit query. Read-only.
 */
export async function getRecentFailuresByErrorClass(limit = 200) {
  const rows = await prisma.brokerIntegrationFailure.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const groups = new Map<string, { count: number; samples: FailureRow[] }>();
  for (const row of rows) {
    const g = groups.get(row.errorClass) ?? { count: 0, samples: [] };
    g.count += 1;
    if (g.samples.length < 5) g.samples.push(row);
    groups.set(row.errorClass, g);
  }

  return Array.from(groups.entries())
    .map(([errorClass, g]) => ({
      errorClass,
      count: g.count,
      samples: g.samples.map((s) => ({
        operation: s.operation,
        broker: s.broker,
        errorCode: s.errorCode,
        recoveryAction: s.recoveryAction,
        createdAt: s.createdAt,
      })),
    }))
    .sort((a, b) => b.count - a.count);
}
