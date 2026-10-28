"use server";

import { requireAdmin, getAdminActorEmail } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { recordAdminAction } from "@usemoney/services";
import type { BrokerType } from "@usemoney/database";

const PAGE_SIZE = 50;

// ── Broker integration failures (MONEY-502 / ZA-4) ──

export interface BrokerFailureRow {
  id: string;
  userIdHash: string;
  broker: string;
  operation: string;
  errorClass: string;
  errorCode: string | null;
  userFacingMessage: string;
  recoveryAction: string | null;
  createdAt: string;
}

export interface BrokerFailuresResult {
  rows: BrokerFailureRow[];
  total: number;
  summary: { errorClass: string; count: number }[];
}

export async function getBrokerFailures(filters?: {
  errorClass?: string;
  broker?: string;
  skip?: number;
}): Promise<BrokerFailuresResult> {
  await requireAdmin();

  const where = {
    ...(filters?.errorClass ? { errorClass: filters.errorClass } : {}),
    ...(filters?.broker ? { broker: filters.broker as BrokerType } : {}),
  };

  const [rows, total, grouped] = await Promise.all([
    prisma.brokerIntegrationFailure.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: filters?.skip ?? 0,
    }),
    prisma.brokerIntegrationFailure.count({ where }),
    prisma.brokerIntegrationFailure
      .groupBy({ by: ["errorClass"], where, _count: { _all: true } })
      .catch(() => [] as { errorClass: string; _count: { _all: number } }[]),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      userIdHash: r.userIdHash,
      broker: r.broker,
      operation: r.operation,
      errorClass: r.errorClass,
      errorCode: r.errorCode,
      userFacingMessage: r.userFacingMessage,
      recoveryAction: r.recoveryAction,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    summary: grouped
      .map((g) => ({ errorClass: g.errorClass, count: g._count._all }))
      .sort((a, b) => b.count - a.count),
  };
}

// ── Consent records (SEBI IA Reg 18(9)) ──

export interface ConsentRow {
  id: string;
  userEmail: string;
  kind: string;
  version: string;
  acceptedAt: string;
  source: string | null;
}

export async function getConsentRecords(filters?: {
  userEmail?: string;
  skip?: number;
}): Promise<{ rows: ConsentRow[]; total: number }> {
  await requireAdmin();

  let userId: string | undefined;
  if (filters?.userEmail) {
    const user = await prisma.user.findUnique({
      where: { email: filters.userEmail.toLowerCase() },
      select: { id: true },
    });
    if (!user) return { rows: [], total: 0 };
    userId = user.id;
  }

  const where = userId ? { userId } : {};
  const [records, total] = await Promise.all([
    prisma.consentRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: filters?.skip ?? 0,
      include: { user: { select: { email: true } } },
    }),
    prisma.consentRecord.count({ where }),
  ]);

  return {
    rows: records.map((r) => ({
      id: r.id,
      userEmail: r.user.email,
      kind: r.kind,
      version: r.version,
      acceptedAt: r.acceptedAt.toISOString(),
      source: r.source,
    })),
    total,
  };
}

/**
 * Per-user consent export (CSV/JSON) — satisfies the Reg 18(9) "exportable for
 * any user" acceptance. Audit-logged (exporting consent PII is an admin action).
 */
export async function getConsentExport(
  userEmail: string,
  format: "csv" | "json",
): Promise<{ filename: string; content: string }> {
  await requireAdmin();
  const actor = await getAdminActorEmail();

  const user = await prisma.user.findUnique({
    where: { email: userEmail.toLowerCase() },
    select: { id: true },
  });
  if (!user) throw new Error("User not found");

  const records = await prisma.consentRecord.findMany({
    where: { userId: user.id },
    orderBy: { acceptedAt: "asc" },
  });

  await recordAdminAction({
    actorEmail: actor,
    action: "consent.export",
    targetType: "User",
    targetId: userEmail.toLowerCase(),
    diff: { count: records.length, format },
  });

  if (format === "json") {
    return {
      filename: `consent-${userEmail}.json`,
      content: JSON.stringify(
        records.map((r) => ({
          kind: r.kind,
          version: r.version,
          acceptedAt: r.acceptedAt.toISOString(),
          source: r.source,
        })),
        null,
        2,
      ),
    };
  }

  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = "kind,version,acceptedAt,source";
  const lines = records.map((r) =>
    [r.kind, r.version, r.acceptedAt.toISOString(), r.source ?? ""]
      .map((v) => esc(String(v)))
      .join(","),
  );
  return {
    filename: `consent-${userEmail}.csv`,
    content: [header, ...lines].join("\n"),
  };
}

// ── Sync logs ──

export interface SyncLogRow {
  id: string;
  userEmail: string;
  broker: string;
  syncType: string;
  status: string;
  recordsFetched: number;
  recordsUpdated: number;
  recordsCreated: number;
  errorMessage: string | null;
  duration: number | null;
  createdAt: string;
}

export async function getSyncLogs(filters?: {
  status?: string;
  broker?: string;
  skip?: number;
}): Promise<{ rows: SyncLogRow[]; total: number }> {
  await requireAdmin();

  const where = {
    ...(filters?.status ? { status: filters.status } : {}),
    ...(filters?.broker ? { broker: filters.broker as BrokerType } : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.syncLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: filters?.skip ?? 0,
      include: { user: { select: { email: true } } },
    }),
    prisma.syncLog.count({ where }),
  ]);

  return {
    rows: logs.map((l) => ({
      id: l.id,
      userEmail: l.user.email,
      broker: l.broker,
      syncType: l.syncType,
      status: l.status,
      recordsFetched: l.recordsFetched,
      recordsUpdated: l.recordsUpdated,
      recordsCreated: l.recordsCreated,
      errorMessage: l.errorMessage,
      duration: l.duration,
      createdAt: l.createdAt.toISOString(),
    })),
    total,
  };
}
