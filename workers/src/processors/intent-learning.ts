/**
 * Intent Learning Processor
 *
 * Daily analysis pipeline that examines ClassificationLog entries,
 * detects misclassifications, generates corrections, and pushes
 * learned patterns to Redis for the Flash prompt.
 *
 * Runs daily at 3 AM IST (21:30 UTC).
 *
 * Pipeline:
 * 1. Analyze: Query ClassificationLog for past 24h failures/signals
 * 2. Generate: Use Gemini Flash to create correction patterns
 * 3. Apply: Serialize active patterns to Redis for web app consumption
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";

const MAX_ACTIVE_PATTERNS = 50;

interface AnalysisCluster {
  type:
    | "flash_failure"
    | "escalation"
    | "safety_net"
    | "rephrase"
    | "low_confidence";
  messages: string[];
  logIds: string[];
  suggestedIntent?: string;
  suggestedTier?: string;
  suggestedTool?: string;
}

export async function processIntentLearning(): Promise<void> {
  console.log("[intent-learning] Starting daily analysis pipeline");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // MONEY-1250 — the two counters the job outcome is built from.
  //
  // `decided` is incremented BEFORE each write and `written` AFTER it, so the
  // pair is not the same number by construction. There is no per-write
  // try/catch in this job: the first `learnedPattern` write that throws aborts
  // the run. Reported from a `finally`, that abort arrives as
  // `selected = N, written = 0`, which is the shape the monitor alerts on.
  // Reported from the end of the happy path it would arrive as nothing at all.
  let decided = 0;
  let written = 0;
  let pruned = 0;
  let totalSignals = 0;
  let outcome = "completed";

  try {
    // ── Step 1: Analyze ──────────────────────────────────────────────────

    const [flashFailures, escalations, safetyNets, rephrases, lowConfidence] =
      await Promise.all([
        prisma.classificationLog.findMany({
          where: { flashFailed: true, createdAt: { gte: since } },
          select: {
            id: true,
            message: true,
            intent: true,
            tier: true,
            tool: true,
          },
          take: 200,
        }),
        prisma.classificationLog.findMany({
          where: { userEscalated: true, createdAt: { gte: since } },
          select: {
            id: true,
            message: true,
            intent: true,
            tier: true,
            tool: true,
          },
          take: 200,
        }),
        prisma.classificationLog.findMany({
          where: { safetyNetActivated: true, createdAt: { gte: since } },
          select: {
            id: true,
            message: true,
            intent: true,
            tier: true,
            tool: true,
          },
          take: 200,
        }),
        prisma.classificationLog.findMany({
          where: { userRephrased: true, createdAt: { gte: since } },
          select: {
            id: true,
            message: true,
            intent: true,
            tier: true,
            tool: true,
          },
          take: 200,
        }),
        prisma.classificationLog.findMany({
          where: {
            confidence: { lt: 0.6 },
            source: "flash",
            createdAt: { gte: since },
          },
          select: {
            id: true,
            message: true,
            intent: true,
            tier: true,
            tool: true,
          },
          take: 200,
        }),
      ]);

    const clusters: AnalysisCluster[] = [];

    if (flashFailures.length > 0) {
      clusters.push({
        type: "flash_failure",
        messages: flashFailures.map((l) => l.message),
        logIds: flashFailures.map((l) => l.id),
      });
    }
    if (escalations.length > 0) {
      clusters.push({
        type: "escalation",
        messages: escalations.map((l) => l.message),
        logIds: escalations.map((l) => l.id),
        suggestedTier: "L2",
      });
    }
    if (safetyNets.length > 0) {
      clusters.push({
        type: "safety_net",
        messages: safetyNets.map((l) => l.message),
        logIds: safetyNets.map((l) => l.id),
        suggestedIntent: "screener",
        suggestedTool: "run_screener",
      });
    }
    if (rephrases.length > 0) {
      clusters.push({
        type: "rephrase",
        messages: rephrases.map((l) => l.message),
        logIds: rephrases.map((l) => l.id),
      });
    }
    if (lowConfidence.length > 0) {
      clusters.push({
        type: "low_confidence",
        messages: lowConfidence.map((l) => l.message),
        logIds: lowConfidence.map((l) => l.id),
      });
    }

    totalSignals = clusters.reduce((sum, c) => sum + c.messages.length, 0);
    console.log(
      `[intent-learning] Found ${totalSignals} signals across ${clusters.length} clusters`,
    );

    if (totalSignals === 0) {
      console.log(
        "[intent-learning] No signals to process, skipping generation",
      );
      // Still apply existing patterns to refresh Redis TTL
      await applyPatternsToRedis();
      outcome = "no-signals";
      return;
    }

    // ── Step 2: Generate corrections ─────────────────────────────────────

    for (const cluster of clusters) {
      // Deduplicate similar messages
      const uniqueMessages = [...new Set(cluster.messages)].slice(0, 10);

      for (const message of uniqueMessages) {
        // Check if we already have a pattern for a very similar message
        const existing = await prisma.learnedPattern.findFirst({
          where: {
            exampleMessage: message,
            status: "active",
          },
        });

        if (existing) {
          // Increment hit count instead of creating duplicate
          decided++;
          await prisma.learnedPattern.update({
            where: { id: existing.id },
            data: { hitCount: { increment: 1 } },
          });
          written++;
          continue;
        }

        // Determine the correction based on cluster type
        let correctIntent = cluster.suggestedIntent;
        let correctTier = cluster.suggestedTier;
        let correctTool = cluster.suggestedTool;

        // For safety net activations, we know it should be screener
        if (cluster.type === "safety_net") {
          correctIntent = "screener";
          correctTier = "L2";
          correctTool = "run_screener";
        }

        // For escalations, the user's second attempt was L2
        if (cluster.type === "escalation") {
          correctTier = "L2";
        }

        // Only create pattern if we have at least intent or tier correction.
        //
        // A message that reaches here with NO correction owes no write, by
        // design: the flash_failure / rephrase / low_confidence clusters carry
        // no `suggested*` field, so all they can ever do is bump an existing
        // pattern's hitCount above. That is why `selected` is `decided` and not
        // `totalSignals` — a night of 200 uncorrectable signals is a night the
        // job correctly wrote nothing, and pairing it with `written` would page
        // for a designed outcome.
        if (correctIntent || correctTier || correctTool) {
          decided++;
          await prisma.learnedPattern.create({
            data: {
              patternType: "flash_example",
              exampleMessage: message.slice(0, 500),
              correctIntent,
              correctTier,
              correctTool,
              learnedFrom: cluster.logIds.slice(0, 10),
              generatedBy: "worker_analysis",
              status: "active",
            },
          });
          written++;
        }
      }
    }

    // Prune to MAX_ACTIVE_PATTERNS (keep highest hitCount)
    const activeCount = await prisma.learnedPattern.count({
      where: { status: "active" },
    });

    if (activeCount > MAX_ACTIVE_PATTERNS) {
      const toDeactivate = await prisma.learnedPattern.findMany({
        where: { status: "active" },
        orderBy: { hitCount: "asc" },
        take: activeCount - MAX_ACTIVE_PATTERNS,
        select: { id: true },
      });

      if (toDeactivate.length > 0) {
        const res = await prisma.learnedPattern.updateMany({
          where: { id: { in: toDeactivate.map((p) => p.id) } },
          data: { status: "pruned" },
        });
        // Housekeeping, deliberately NOT part of the selected/written pair: a
        // prune only happens above MAX_ACTIVE_PATTERNS, so folding it in would
        // make `written` non-zero on a run that learned nothing.
        pruned = res.count;
        console.log(
          `[intent-learning] Pruned ${toDeactivate.length} low-hit patterns`,
        );
      }
    }

    // ── Step 3: Apply to Redis ───────────────────────────────────────────

    await applyPatternsToRedis();

    console.log("[intent-learning] Pipeline complete");
  } catch (err) {
    // THE CRASH MUST NOT REPORT "completed" — MONEY-1250 review.
    //
    // `outcome` was only ever assigned "completed" or "no-signals", and the
    // `finally` had no access to the error. A throw in the five `findMany`
    // queries, in `applyPatternsToRedis()`, or in the prune block therefore
    // reported `outcome=completed` on a run that crashed — a string that says
    // the run finished. `intraday-sync` and `price-sync` both carry a `threw:`
    // reason on their catch paths; this one did not.
    //
    // The 0/0 counts are defensible when nothing had been decided yet. The
    // MISLEADING STRING was the defect.
    outcome = `threw: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    // MONEY-1250 — `selected` is writes DECIDED, not signals FOUND.
    //
    // `totalSignals` is every ClassificationLog row that tripped one of the
    // five detectors in the last 24h. Most of them owe no write at all (see the
    // note on the create branch), so pairing it with `written` would report
    // `selected 200, written 0` on a perfectly correct night. `decided` counts
    // only the messages this run resolved to an update or a create, which is
    // zero exactly when the job had nothing to learn.
    reportJobOutcome({
      job: "intent-learning",
      selected: decided,
      written,
      failed: decided - written,
      skippedReason:
        `outcome=${outcome} signals=${totalSignals} decided=${decided} ` +
        `written=${written} pruned=${pruned}`,
    });
  }
}

async function applyPatternsToRedis(): Promise<void> {
  // @usemoney/cache no longer exposes a raw Redis handle. Active
  // patterns + examples are persisted to MongoDB by the steps above
  // and read at request time via the cache wrap() helper, so the
  // Redis fan-out is a no-op for now.
  //
  // Restoring real fan-out: surface a `getRedisClient` from
  // packages/cache and lift the example/pattern projection from git
  // history (last seen in commit before MONEY-298 cleanup).
  const count = await prisma.learnedPattern
    .count({ where: { status: "active" } })
    .catch(() => 0);
  console.log(
    `[intent-learning] Mongo-backed read path canonical - skipping Redis fan-out for ${count} active patterns.`,
  );
}
