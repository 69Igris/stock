/**
 * Broker Connection Server Actions
 * Handles OAuth flow, token storage, and data sync
 */
"use server";

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateDbUser } from "@/lib/db/user";
import { encryption } from "@usemoney/security/encryption";
import {
  generateOAuthState,
  verifyOAuthState,
  storeReauthIntent,
  consumeReauthIntent,
} from "@usemoney/core/brokers/oauth-state";
import { isDemoSession } from "@/lib/demo/session";
import { demoBrokerConnections } from "@/lib/demo/data";
import {
  getBrokerConfig,
  getBrokerEnvKeys,
  clearBrokerSyncCache,
  clearBrokerConnectionCache,
  clearPositionCache,
  clearTradeCache,
} from "@usemoney/core";
import type { BrokerType } from "@usemoney/types";
// MONEY-841: stable per-user shard, set when CREATING a connection so the daily
// fan-out cron can target it. Same hash on web + worker (lives in @usemoney/types).
import { syncBucketFor } from "@usemoney/types/pubsub";
import {
  createBrokerClient,
  ZerodhaClient,
  UpstoxClient,
  FyersClient,
  IciciClient,
  HdfcClient,
  InteractiveBrokersClient,
} from "@/lib/brokers/clients";
import { buildBrokerOAuthUrl } from "@/lib/brokers/oauth-url";
import { isConnectFounder } from "@/lib/brokers/connect-gate";
import { revalidatePath } from "next/cache";
import { getSubscriptionAccess } from "@/lib/subscription/access";
import { syncLogger as logger } from "@usemoney/logger";
import { recordBrokerFailure } from "@/lib/brokers/failure-log";
import { createNotification } from "@/lib/db/notifications";
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";
import { mapKnownBrokerError } from "@/lib/brokers/known-errors";
import {
  sendEmail,
  getEffectivePreferences,
  shouldSendEmail,
  buildUnsubscribeUrl,
} from "@usemoney/email";
import {
  BrokerConnectedEmail,
  BrokerDisconnectedEmail,
} from "@usemoney/email/templates";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getBrokerConnections,
  deleteBrokerConnection,
  syncHistoricalTradebook,
  persistBrokerConnection,
  diagnoseMFPairing,
  buildIsinMap,
  matchIsinForTrade,
  NO_CONNECTIONS_ERROR,
} from "@usemoney/services";
import { publishSyncJob, publishPairingJob } from "@usemoney/pubsub/publish";
import {
  parseHistoricalSyncDays,
  staleBrokerJobCutoff,
  mapBrokerSyncJobStatus,
} from "@/lib/actions/broker-connection-logic";
import React from "react";

// Get or create user helper.
// MONEY-1062 (W2-B): the inferior inline copy (which checked only
// PENDING/PROCESSING deletion states — MISSING the LOCKED guard, and could
// resurrect a user mid-purge) is deleted in favour of the canonical
// getOrCreateDbUser (lib/db/user.ts): PENDING/PROCESSING/LOCKED deletion guard,
// 5-min cache, P2002 race-retry, and Clerk-404 handling. This wrapper only
// adapts the Clerk-session → clerkUserId boundary the callers rely on.
async function getOrCreateUser() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return null;
  }
  return getOrCreateDbUser(clerkUserId);
}

// ================== OAuth Flow ==================

/**
 * MONEY-837: whether the current user may use the founder-only Zerodha Connect
 * (paid live-data) app. The brokers page uses this to reveal a founder-only
 * "Zerodha Connect (live data)" connect card. Returns false (never throws) for
 * demo / unauthenticated / non-founder.
 */
export async function getConnectFounderStatusAction(): Promise<{
  isFounder: boolean;
}> {
  try {
    if (await isDemoSession()) return { isFounder: false };
    const user = await getOrCreateUser();
    return { isFounder: !!user && isConnectFounder(user.email) };
  } catch {
    return { isFounder: false };
  }
}

export async function getOAuthUrlAction(
  broker: BrokerType,
  connectionId?: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const user = await getOrCreateUser();
    if (!user) {
      return { success: false, error: "Authentication required" };
    }

    // MONEY-837: the paid Connect app is founder-only.
    if (broker === "ZERODHA_CONNECT" && !isConnectFounder(user.email)) {
      return { success: false, error: "This broker is not available." };
    }

    // MONEY-837: free-tier gate (skip the founder-only Connect connector). A
    // lapsed trial blocks ALL connect/re-auth; the single-broker limit blocks
    // only NEW connects — re-auth of an existing connection (connectionId set)
    // stays allowed.
    if (broker !== "ZERODHA_CONNECT") {
      const gate = await getBrokerGate(user.id);
      if (gate.isFree && gate.trialExpired) {
        return {
          success: false,
          error:
            "Your 30-day free trial has ended. Upgrade to Pro to connect or re-authorise brokers.",
        };
      }
      if (gate.isFree && !connectionId && gate.connectionCount >= 1) {
        return {
          success: false,
          error:
            "The Free plan includes one broker. Upgrade to Pro to connect more.",
        };
      }
    }

    // MONEY-837: a re-auth targets a SPECIFIC connection. Kite has no
    // login_hint, so record which account this re-auth must land on; the
    // callback rejects a wrong-account login instead of silently rewriting the
    // user's OTHER connection on the same broker.
    if (connectionId) {
      const reauthConn = await prisma.brokerConnection.findFirst({
        where: { id: connectionId, userId: user.id, broker },
        select: { id: true, brokerUserId: true },
      });
      if (reauthConn?.brokerUserId) {
        await storeReauthIntent(user.id, broker, {
          connectionId: reauthConn.id,
          expectedBrokerUserId: reauthConn.brokerUserId,
        });
      }
    }

    const config = getBrokerConfig(broker);
    const envKeys = getBrokerEnvKeys(broker);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const redirectUri =
      envKeys.redirectUri ||
      `${baseUrl}/api/brokers/${broker.toLowerCase()}/callback`;

    if (!envKeys.apiKey) {
      logger.error(
        { broker, envKey: config.envKeys.apiKey },
        "Broker API key not configured - check environment variables"
      );
      return {
        success: false,
        error: "This broker is not available yet. Please try again later.",
      };
    }

    // MONEY-287 - mint a CSRF state token bound to (userId, broker)
    // and append it to every OAuth authorization URL. Callbacks
    // verify-and-delete via `verifyOAuthState()`.
    const csrfState = await generateOAuthState(user.id, broker);
    // Per-broker login-URL + CSRF-state wiring lives in a pure, unit-tested
    // helper (lib/brokers/oauth-url.ts) so the state round-trip contract —
    // e.g. Zerodha's redirect_params requirement — is regression-guarded.
    return buildBrokerOAuthUrl(broker, {
      apiKey: envKeys.apiKey,
      redirectUri,
      csrfState,
      fallbackState: user.id,
      angelApiKey: process.env.ANGEL_API_KEY || envKeys.apiKey,
    });
  } catch (error: unknown) {
    logger.error(
      { error, broker, action: "getOAuthUrlAction" },
      "OAuth URL generation error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to generate OAuth URL"),
    };
  }
}

// Helper to check if trial expired for free users
async function checkTrialExpiry(
  userId: string
): Promise<{ expired: boolean; remainingDays: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, brokerTrialEndsAt: true },
  });

  // MONEY-877: the trial ends at brokerTrialEndsAt when set (a fixed, resettable
  // expiry), else createdAt + 30d. Missing/corrupt → fail OPEN (never lock a user
  // out on absent/bad metadata; the trial is a soft gate, not a wall).
  const createdAt = user?.createdAt ? new Date(user.createdAt) : null;
  const effectiveEnd = user?.brokerTrialEndsAt
    ? new Date(user.brokerTrialEndsAt)
    : createdAt
      ? new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000)
      : null;
  if (!effectiveEnd || Number.isNaN(effectiveEnd.getTime())) {
    return { expired: false, remainingDays: 30 };
  }

  const msLeft = effectiveEnd.getTime() - Date.now();
  const remainingDays = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  const expired = msLeft <= 0;

  return { expired, remainingDays };
}

// MONEY-837: free-tier broker gate. The Free plan includes ONE broker for a
// 30-day trial (from signup); after that, connecting / re-authorising AND
// syncing are disabled — upgrade to Pro. Paid plans are never gated.
async function getBrokerGate(userId: string): Promise<{
  isFree: boolean;
  trialExpired: boolean;
  remainingDays: number;
  connectionCount: number;
}> {
  const subscription = await getSubscriptionAccess();
  if (subscription.planId !== "FREE") {
    return {
      isFree: false,
      trialExpired: false,
      remainingDays: 30,
      connectionCount: 0,
    };
  }
  const trial = await checkTrialExpiry(userId);
  // ZERODHA_CONNECT is a founder-only connector (free users never have it); the
  // single-broker limit counts only real portfolio brokers.
  const connectionCount = await prisma.brokerConnection.count({
    where: { userId, broker: { not: "ZERODHA_CONNECT" } },
  });
  return {
    isFree: true,
    trialExpired: trial.expired,
    remainingDays: trial.remainingDays,
    connectionCount,
  };
}

/**
 * MONEY-837: free-tier broker gate status for the brokers-page upgrade banner.
 * Never throws (banner is best-effort).
 */
export async function getBrokerGateStatusAction(): Promise<{
  isFree: boolean;
  trialExpired: boolean;
  remainingDays: number;
  atBrokerLimit: boolean;
}> {
  const FALLBACK = {
    isFree: false,
    trialExpired: false,
    remainingDays: 30,
    atBrokerLimit: false,
  };
  try {
    if (await isDemoSession()) return FALLBACK;
    const user = await getOrCreateUser();
    if (!user) return FALLBACK;
    const gate = await getBrokerGate(user.id);
    return {
      isFree: gate.isFree,
      trialExpired: gate.trialExpired,
      remainingDays: gate.remainingDays,
      atBrokerLimit: gate.isFree && gate.connectionCount >= 1,
    };
  } catch {
    return FALLBACK;
  }
}

// Handle OAuth callback and store tokens
export async function handleOAuthCallbackAction(
  broker: BrokerType,
  code: string,
  state?: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  let oauthUserId = "";
  try {
    const user = await getOrCreateUser();
    if (!user) {
      return { success: false, error: "Authentication required" };
    }
    oauthUserId = user.id;

    // MONEY-837: the paid Connect app is founder-only.
    if (broker === "ZERODHA_CONNECT" && !isConnectFounder(user.email)) {
      logger.warn(
        { broker, userId: user.id },
        "[oauth] non-founder attempted ZERODHA_CONNECT - rejecting"
      );
      return { success: false, error: "This broker is not available." };
    }

    // MONEY-287 - CSRF state verification. OAuth init persisted a
    // random state in Redis bound to (user.id, broker); the callback
    // verifies-and-deletes it. Mismatch → reject. We accept a missing
    // state during the migration window (some brokers' callbacks may
    // not round-trip the param yet); flip to hard-fail with
    // OAUTH_STATE_STRICT=1 once all 7 round-trips are verified in prod.
    // MONEY-592 (security audit): state is now MANDATORY (secure-by-default).
    // getOAuthUrlAction mints + appends a CSRF state for every broker on init
    // (broker-connection.ts:175), so a callback arriving WITHOUT state is
    // malformed/forged, never a legitimate flow. The previous behaviour only
    // hard-failed missing-state when OAUTH_STATE_STRICT=1, leaving any env where
    // the flag was unset open to login-CSRF. The OAUTH_STATE_STRICT escape hatch
    // is removed; an explicit OAUTH_STATE_ALLOW_MISSING=1 remains only as a
    // break-glass for the (now-verified-complete) migration window.
    const allowMissingState = process.env.OAUTH_STATE_ALLOW_MISSING === "1";
    if (!state && !allowMissingState) {
      logger.warn(
        { broker, userId: user.id },
        "[oauth] CSRF state missing - rejecting callback"
      );
      void recordBrokerFailure({
        userId: oauthUserId,
        broker,
        operation: "oauth_callback_csrf_missing",
        error: new Error("CSRF state missing on OAuth callback"),
      });
      return {
        success: false,
        error:
          "Authentication failed (security state missing). Please try connecting again.",
      };
    }
    if (state) {
      const ok = await verifyOAuthState(user.id, broker, state);
      if (!ok) {
        logger.warn(
          { broker, userId: user.id },
          "[oauth] CSRF state mismatch - rejecting callback"
        );
        void recordBrokerFailure({
          userId: oauthUserId,
          broker,
          operation: "oauth_callback_csrf_mismatch",
          error: new Error("CSRF state mismatch on OAuth callback"),
        });
        return {
          success: false,
          error:
            "Authentication failed (security state mismatch). Please try connecting again.",
        };
      }
    }

    // Check trial expiry for free users
    const subscription = await getSubscriptionAccess();
    if (subscription.planId === "FREE") {
      const trialCheck = await checkTrialExpiry(user.id);
      if (trialCheck.expired) {
        logger.warn(
          { broker, userId: user.id },
          "[oauth] broker-sync trial expired - rejecting"
        );
        void recordBrokerFailure({
          userId: user.id,
          broker,
          operation: "oauth_callback_trial_expired",
          error: new Error("Broker sync trial expired"),
        });
        return {
          success: false,
          error:
            "Your 30-day broker sync trial has expired. Upgrade to Pro to continue using broker connections.",
        };
      }
    }

    const config = getBrokerConfig(broker);
    const envKeys = getBrokerEnvKeys(broker);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const redirectUri =
      envKeys.redirectUri ||
      `${baseUrl}/api/brokers/${broker.toLowerCase()}/callback`;

    let accessToken: string;
    let refreshToken: string | undefined;
    let userId: string | undefined;
    let tokenExpiry: Date | undefined;

    // Exchange code for tokens based on broker
    switch (broker) {
      // MONEY-837: ZERODHA_CONNECT shares Zerodha's token exchange; only the env
      // keys (ZERODHA_CONNECT_*) differ — already resolved via getBrokerEnvKeys.
      case "ZERODHA":
      case "ZERODHA_CONNECT": {
        const result = await ZerodhaClient.exchangeToken(
          envKeys.apiKey,
          envKeys.apiSecret,
          code
        );
        accessToken = result.accessToken;
        userId = result.userId;
        // Zerodha tokens expire at end of day (3:30 AM next day)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(3, 30, 0, 0);
        tokenExpiry = tomorrow;
        break;
      }
      case "UPSTOX": {
        const result = await UpstoxClient.exchangeToken(
          envKeys.apiKey,
          envKeys.apiSecret,
          code,
          redirectUri
        );
        accessToken = result.accessToken;
        refreshToken = result.refreshToken;
        // Upstox tokens are valid for 1 year
        tokenExpiry = new Date(Date.now() + result.expiresIn * 1000);
        break;
      }
      case "FYERS": {
        const result = await FyersClient.exchangeToken(
          envKeys.apiKey,
          envKeys.apiSecret,
          code
        );
        accessToken = result.accessToken;
        refreshToken = result.refreshToken;
        // Fyers tokens expire daily
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(7, 0, 0, 0);
        tokenExpiry = tomorrow;
        break;
      }
      case "ANGEL_ONE": {
        // Angel One Publisher Login returns auth_token directly in the redirect URL
        // The `code` param here IS the auth_token (JWT) from the publisher login
        accessToken = code;
        // Get a refresh token by calling the profile endpoint which confirms the token works
        // The auth_token from publisher login is a full JWT - no exchange needed
        userId = ""; // Will be populated from profile call after connection
        // Token expires at midnight IST (~18:30 UTC)
        const angelExpiry = new Date();
        angelExpiry.setUTCHours(18, 30, 0, 0);
        if (angelExpiry < new Date()) {
          angelExpiry.setDate(angelExpiry.getDate() + 1);
        }
        tokenExpiry = angelExpiry;
        break;
      }
      case "ICICI": {
        const iciciResult = await IciciClient.exchangeToken(
          envKeys.apiKey,
          envKeys.apiSecret,
          code
        );
        accessToken = iciciResult.accessToken;
        userId = iciciResult.userId;
        // ICICI tokens expire at midnight IST (~18:30 UTC)
        const iciciExpiry = new Date();
        iciciExpiry.setUTCHours(18, 30, 0, 0);
        if (iciciExpiry < new Date()) {
          iciciExpiry.setDate(iciciExpiry.getDate() + 1);
        }
        tokenExpiry = iciciExpiry;
        break;
      }
      case "HDFC": {
        const hdfcResult = await HdfcClient.exchangeToken(
          envKeys.apiKey,
          envKeys.apiSecret,
          code,
          redirectUri
        );
        accessToken = hdfcResult.accessToken;
        refreshToken = hdfcResult.refreshToken;
        userId = hdfcResult.userId;
        // HDFC tokens expire at midnight IST
        const hdfcExpiry = new Date();
        hdfcExpiry.setUTCHours(18, 30, 0, 0);
        if (hdfcExpiry < new Date()) {
          hdfcExpiry.setDate(hdfcExpiry.getDate() + 1);
        }
        tokenExpiry = hdfcExpiry;
        break;
      }
      // GROWW uses API Key + TOTP auth via POST /connect - no OAuth callback
      case "INTERACTIVE_BROKERS": {
        const result = await InteractiveBrokersClient.exchangeToken(
          envKeys.apiKey,
          envKeys.apiSecret,
          code,
          redirectUri
        );
        accessToken = result.accessToken;
        refreshToken = result.refreshToken;
        // IBKR tokens expire in 24 hours
        tokenExpiry = new Date(Date.now() + result.expiresIn * 1000);
        break;
      }
      default:
        return {
          success: false,
          error:
            "This connection method is not available for the selected broker.",
        };
    }

    // MONEY-837: if this was a re-auth of a SPECIFIC connection, the user MUST
    // have logged into that same broker account. Kite pre-fills the last-used
    // account, so a careless re-auth can land on the WRONG one — reject (with a
    // clear next step) instead of silently rewriting the other connection.
    const reauthIntent = await consumeReauthIntent(user.id, broker);
    if (
      reauthIntent?.expectedBrokerUserId &&
      userId &&
      reauthIntent.expectedBrokerUserId !== userId
    ) {
      logger.warn(
        { broker, expected: reauthIntent.expectedBrokerUserId, got: userId },
        "[oauth] re-auth landed on the wrong broker account - rejecting"
      );
      return {
        success: false,
        error: `You signed in as ${userId}, but you were re-authorising ${reauthIntent.expectedBrokerUserId}. On the broker login screen, tap "Change user" and sign in as ${reauthIntent.expectedBrokerUserId}.`,
      };
    }

    // Encrypt credentials
    const credentials = {
      accessToken,
      refreshToken,
      apiKey: envKeys.apiKey,
      userId,
    };
    const encrypted = encryption.encrypt(credentials);

    // Store or update broker connection
    // Check for existing connection with same brokerUserId to avoid duplicates
    const existing = await prisma.brokerConnection.findFirst({
      where: {
        userId: user.id,
        broker,
        brokerUserId: userId || null,
      },
    });

    // Use userId as default account name (can be customized by user later)
    const accountName = userId ? `${broker} - ${userId}` : broker;

    if (existing) {
      await prisma.brokerConnection.update({
        where: { id: existing.id },
        data: {
          brokerUserId: userId || null,
          accountName,
          encryptedCreds: encrypted.encrypted,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          status: "CONNECTED",
          tokenExpiry,
          connectedAt: new Date(),
          lastRefreshedAt: new Date(),
          errorMessage: null,
          reconnectAttempts: 0,
          brokerMetadata: { userId },
        },
      });
    } else {
      await prisma.brokerConnection.create({
        data: {
          userId: user.id,
          broker,
          brokerUserId: userId || null,
          accountName,
          encryptedCreds: encrypted.encrypted,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          status: "CONNECTED",
          tokenExpiry,
          connectedAt: new Date(),
          lastRefreshedAt: new Date(),
          brokerMetadata: { userId },
          syncHoldings: true,
          syncPositions: true,
          syncOrders: true,
          // MONEY-841: stamp the stable shard so the daily fan-out cron syncs
          // this connection in its bucket (existing connections are backfilled
          // by scripts/ops/backfill-syncbucket.ts).
          syncBucket: syncBucketFor(user.id),
        },
      });
    }

    revalidatePath("/brokers");

    // MONEY-837: ZERODHA_CONNECT is token-capture only; the Personal app owns
    // all data sync, so skip auto-sync and return success after storing.
    if (broker === "ZERODHA_CONNECT") {
      return { success: true };
    }

    // Auto-sync broker data after successful connection
    try {
      logger.info(
        { broker, userId: user.id },
        "Auto-syncing after broker connection"
      );
      const syncResult = await syncBrokerDataAction(
        broker,
        ["holdings", "positions", "trades", "mutualFunds"],
        undefined,
        { historicalPending: true, isInitialConnect: true }
      );
      if (syncResult.success) {
        logger.info(
          { broker, synced: syncResult.synced },
          "Auto-sync completed"
        );
      } else {
        // MONEY-848: an unsuccessful enqueue (e.g. publishSyncJob threw on a
        // Pub/Sub outage) means the connect email's "syncing shortly" promise
        // won't be kept — surface it at ERROR + record it for telemetry rather
        // than a quiet warn. The connection itself still succeeds (the user can
        // retry Sync), so we don't fail the callback.
        logger.error(
          { broker, error: syncResult.error },
          "Auto-sync enqueue failed after connect, user can sync manually"
        );
        void recordBrokerFailure({
          userId: oauthUserId,
          broker,
          operation: "auto_sync_enqueue",
          error: new Error(syncResult.error || "Auto-sync enqueue failed"),
        });
      }
    } catch (syncError) {
      // Don't fail the connection if sync fails - user can sync manually
      logger.error(
        { broker, error: syncError },
        "Auto-sync error, user can sync manually"
      );
      void recordBrokerFailure({
        userId: oauthUserId,
        broker,
        operation: "auto_sync_enqueue",
        error: syncError,
      });
    }

    // MONEY-839: the historical backfill is part of the SINGLE worker sync job
    // the auto-sync above publishes (syncBrokerDataAction with historicalPending
    // → historicalDays: 730). No separate enqueue needed.

    revalidatePath("/holdings");
    revalidatePath("/positions");
    revalidatePath("/tradebook");
    revalidatePath("/dashboard");
    revalidatePath("/mutual-funds");

    // Send broker connected email (fire-and-forget, preference-gated).
    // getOrCreateDbUser returns a lean DbUser (no emailPreferences), so read the
    // preference blob directly for the gate (mirrors disconnectBrokerAction).
    const connEmailUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { emailPreferences: true },
    });
    const connPrefs = getEffectivePreferences(connEmailUser?.emailPreferences);
    if (shouldSendEmail(connPrefs, "broker-connected")) {
      const unsubUrl = buildUnsubscribeUrl(user.email, "brokerNotifications");
      sendEmail({
        to: user.email,
        subject: `${broker} Broker Connected - UseMoney`,
        unsubscribeUrl: unsubUrl,
        react: React.createElement(BrokerConnectedEmail, {
          name: user.name || "there",
          brokerName: broker,
          brokerUserId: userId || undefined,
          accountName,
          isReauth: Boolean(existing),
          unsubscribeUrl: unsubUrl,
        }),
        template: "broker-connected",
      });
    }

    // In-app (bell) notification so the connect is visible in the
    // notification center, not just via toast/email (fire-and-forget;
    // createNotification swallows + logs its own errors).
    void createNotification({
      userId: user.id,
      type: "SYNC_COMPLETE",
      title: `${broker} connected`,
      message:
        "Your broker is connected. Holdings, positions, trades and funds are syncing.",
      metadata: { broker, event: "broker_connected" },
    });

    return { success: true };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    const known = mapKnownBrokerError(message);
    if (known) {
      logger.warn(
        {
          broker,
          errorCode: known.code,
          error: message,
          action: "handleOAuthCallbackAction",
        },
        `OAuth callback rejected: ${known.code}`
      );
    } else {
      logger.error(
        { error, broker, action: "handleOAuthCallbackAction" },
        "OAuth callback error"
      );
    }
    void recordBrokerFailure({
      userId: oauthUserId,
      broker,
      operation: "oauth_callback",
      error,
    });
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to complete authentication"),
    };
  }
}

// Update broker account name
export async function updateBrokerAccountNameAction(
  connectionId: string,
  accountName: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const user = await getOrCreateUser();
    if (!user) {
      return { success: false, error: "Authentication required" };
    }

    // Validate account name
    if (!accountName || accountName.trim().length === 0) {
      return { success: false, error: "Account name cannot be empty" };
    }

    if (accountName.length > 50) {
      return {
        success: false,
        error: "Account name must be 50 characters or less",
      };
    }

    // Verify connection belongs to user
    const connection = await prisma.brokerConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || connection.userId !== user.id) {
      return { success: false, error: "Connection not found or unauthorized" };
    }

    // Update account name
    await prisma.brokerConnection.update({
      where: { id: connectionId },
      data: { accountName: accountName.trim() },
    });

    revalidatePath("/brokers");
    return { success: true };
  } catch (error: unknown) {
    logger.error(
      { error, connectionId, action: "updateBrokerAccountNameAction" },
      "Update account name error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to update account name"),
    };
  }
}

// Connect with API key (for Dhan, Groww, etc.)
export async function connectWithApiKeyAction(
  broker: BrokerType,
  clientId: string,
  accessToken: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const user = await getOrCreateUser();
    if (!user) {
      return { success: false, error: "Authentication required" };
    }

    // Check trial expiry for free users
    const subscription = await getSubscriptionAccess();
    if (subscription.planId === "FREE") {
      const trialCheck = await checkTrialExpiry(user.id);
      if (trialCheck.expired) {
        return {
          success: false,
          error:
            "Your 30-day broker sync trial has expired. Upgrade to Pro to continue using broker connections.",
        };
      }
    }

    // Validate credentials by making a test request
    const client = createBrokerClient(broker, {
      accessToken,
      userId: clientId,
    });

    try {
      await client.getProfile();
    } catch {
      // Try getting holdings if profile fails
      try {
        await client.getHoldings();
      } catch (error: unknown) {
        logger.warn({ error, broker }, "[apikey] credential validation failed");
        void recordBrokerFailure({
          userId: user.id,
          broker,
          operation: "apikey_validate",
          error,
        });
        return {
          success: false,
          error:
            "Invalid credentials. Please check your Client ID and Access Token.",
        };
      }
    }

    // Persist via the shared upsert service (encrypt → findFirst → update/create).
    // Dhan credentials = { accessToken, userId: clientId }, 30-day expiry; matched
    // by { userId, broker, brokerUserId } (multi-account). The action's own prisma
    // + encryption are injected so the write stays on this request's client.
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const persisted = await persistBrokerConnection(
      {
        userId: user.id,
        broker,
        credentials: { accessToken, userId: clientId },
        tokenExpiry,
        brokerUserId: clientId,
        metadata: { userId: clientId },
      },
      { prisma, encryption }
    );
    if (!persisted.success) {
      void recordBrokerFailure({
        userId: user.id,
        broker,
        operation: "apikey_persist",
        error: new Error(persisted.error),
      });
      return { success: false, error: persisted.error };
    }
    const wasReconnect = persisted.data.wasReconnect;
    const previousAccountName = persisted.data.previousAccountName;

    revalidatePath("/brokers");

    // Auto-sync broker data after successful connection
    try {
      logger.info(
        { broker, userId: user.id },
        "Auto-syncing after API key connection"
      );
      const syncResult = await syncBrokerDataAction(
        broker,
        ["holdings", "positions", "trades", "mutualFunds"],
        undefined,
        { historicalPending: true, isInitialConnect: true }
      );
      if (syncResult.success) {
        logger.info(
          { broker, synced: syncResult.synced },
          "Auto-sync completed"
        );
      } else {
        // MONEY-848: surface an enqueue failure (see the OAuth path) at ERROR +
        // telemetry instead of a quiet warn; the connection still succeeds.
        logger.error(
          { broker, error: syncResult.error },
          "Auto-sync enqueue failed after API key connect, user can sync manually"
        );
        void recordBrokerFailure({
          userId: user.id,
          broker,
          operation: "auto_sync_enqueue",
          error: new Error(syncResult.error || "Auto-sync enqueue failed"),
        });
      }
    } catch (syncError) {
      // Don't fail the connection if sync fails - user can sync manually
      logger.error(
        { broker, error: syncError },
        "Auto-sync error, user can sync manually"
      );
      void recordBrokerFailure({
        userId: user.id,
        broker,
        operation: "auto_sync_enqueue",
        error: syncError,
      });
    }

    // MONEY-839: the historical backfill is part of the SINGLE worker sync job
    // the auto-sync above publishes (syncBrokerDataAction with historicalPending
    // → historicalDays: 730). No separate enqueue needed.

    revalidatePath("/holdings");
    revalidatePath("/positions");
    revalidatePath("/tradebook");
    revalidatePath("/dashboard");
    revalidatePath("/mutual-funds");

    // MONEY-848: the OAuth path sends a BrokerConnected email on connect; the
    // API-key path (Dhan / Groww) did NOT. Send the same preference-gated email
    // + in-app notification so an API-key connect is acknowledged identically.
    // getOrCreateDbUser returns a lean DbUser (no emailPreferences) — read it here.
    const connEmailUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { emailPreferences: true },
    });
    const connPrefs = getEffectivePreferences(connEmailUser?.emailPreferences);
    if (shouldSendEmail(connPrefs, "broker-connected")) {
      const unsubUrl = buildUnsubscribeUrl(user.email, "brokerNotifications");
      sendEmail({
        to: user.email,
        subject: `${broker} Broker Connected - UseMoney`,
        unsubscribeUrl: unsubUrl,
        react: React.createElement(BrokerConnectedEmail, {
          name: user.name || "there",
          brokerName: broker,
          brokerUserId: clientId || undefined,
          accountName: previousAccountName || undefined,
          isReauth: wasReconnect,
          unsubscribeUrl: unsubUrl,
        }),
        template: "broker-connected",
      });
    }

    void createNotification({
      userId: user.id,
      type: "SYNC_COMPLETE",
      title: `${broker} connected`,
      message:
        "Your broker is connected. Holdings, positions, trades and funds are syncing.",
      metadata: { broker, event: "broker_connected" },
    });

    return { success: true };
  } catch (error: unknown) {
    logger.error(
      { error, broker, action: "connectWithApiKeyAction" },
      "API key connection error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to connect"),
    };
  }
}

// ================== Get Connections ==================

export interface BrokerConnectionInfo {
  id: string;
  broker: BrokerType;
  brokerUserId?: string | null;
  accountName?: string | null;
  status: string;
  connectedAt?: string;
  lastSync?: string;
  tokenExpiry?: string;
  isExpired: boolean;
  needsReauth: boolean;
}

export async function getBrokerConnectionsAction(opts?: {
  /** Include the founder-only ZERODHA_CONNECT connector — brokers/management UI ONLY. */
  includeConnectOnly?: boolean;
}): Promise<{
  success: boolean;
  data?: BrokerConnectionInfo[];
  error?: string;
}> {
  // MONEY-837: every caller is a DATA selector by default (holdings/positions/
  // tradebook filters, roast, chat, manual entry, …) and must NOT see the
  // founder-only Connect connector — it has no portfolio data. Only the brokers
  // management UI opts in via includeConnectOnly. Central guard so no current OR
  // future selector can leak it.
  const keep = (rows: BrokerConnectionInfo[]) =>
    opts?.includeConnectOnly
      ? rows
      : rows.filter((c) => c.broker !== "ZERODHA_CONNECT");

  if (await isDemoSession()) {
    return {
      success: true,
      data: keep(demoBrokerConnections as unknown as BrokerConnectionInfo[]),
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: true, data: [] };
    }

    const result = await getBrokerConnections(authUser.userId);

    if (!result?.success) {
      return {
        success: false,
        error: result?.error,
      };
    }

    return {
      success: true,
      data: keep(result?.data as BrokerConnectionInfo[]),
    };
  } catch (error: unknown) {
    logger.error(
      { error, action: "getBrokerConnectionsAction" },
      "Error fetching connections"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to fetch connections"),
    };
  }
}

// ================== Disconnect ==================

export interface BrokerDataCounts {
  holdings: number;
  positions: number;
  trades: number;
  importedTrades: number;
  manualTrades: number;
  mutualFunds: number;
  pairedTrades: number;
  orders: number;
}

export async function getBrokerDataCountsAction(
  broker: BrokerType,
  connectionId?: string
): Promise<{ success: boolean; data?: BrokerDataCounts; error?: string }> {
  try {
    const user = await getOrCreateUser();
    if (!user) {
      return { success: false, error: "Authentication required" };
    }

    let brokerUserId: string | null | undefined = undefined;

    if (connectionId) {
      const connection = await prisma.brokerConnection.findUnique({
        where: { id: connectionId },
      });

      if (
        !connection ||
        connection.userId !== user.id ||
        connection.broker !== broker
      ) {
        return { success: false, error: "Connection not found" };
      }

      brokerUserId = connection.brokerUserId;
    }

    const whereClause = connectionId
      ? { userId: user.id, broker, brokerUserId }
      : { userId: user.id, broker };

    const [
      holdings,
      positions,
      trades,
      importedTrades,
      manualTrades,
      mutualFunds,
      pairedTrades,
      orders,
    ] = await Promise.all([
      prisma.holding.count({ where: whereClause }),
      prisma.position.count({ where: whereClause }),
      prisma.trade.count({ where: whereClause }),
      prisma.trade.count({ where: { ...whereClause, sourceType: "IMPORTED" } }),
      prisma.trade.count({ where: { ...whereClause, sourceType: "MANUAL" } }),
      prisma.mutualFund.count({ where: whereClause }),
      prisma.pairedTradeView.count({ where: whereClause }),
      prisma.order.count({ where: whereClause }),
    ]);

    return {
      success: true,
      data: {
        holdings,
        positions,
        trades,
        importedTrades,
        manualTrades,
        mutualFunds,
        pairedTrades,
        orders,
      },
    };
  } catch (error: unknown) {
    logger.error(
      { error, broker, connectionId, action: "getBrokerDataCountsAction" },
      "Error fetching data counts"
    );
    return { success: false, error: "Failed to fetch data counts" };
  }
}

export async function disconnectBrokerAction(
  broker: BrokerType,
  connectionId?: string // Optional: disconnect specific account by connection ID
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    // Get user info for email before deleting
    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { email: true, name: true, emailPreferences: true },
    });

    if (connectionId) {
      // Use service to delete specific connection (handles data cascade + cache clearing)
      const result = await deleteBrokerConnection(
        authUser.userId,
        connectionId
      );
      if (!result?.success) {
        return { success: false, error: result?.error };
      }
    } else {
      // Backwards-compatible: disconnect all accounts for this broker
      // Service only handles single connectionId, so we use the existing logic for bulk
      const connections = await prisma.brokerConnection.findMany({
        where: { userId: authUser.userId, broker },
        select: { id: true },
      });

      // Delete each connection via service (handles data cascade + cache clearing)
      for (const conn of connections) {
        const result = await deleteBrokerConnection(authUser.userId, conn.id);
        if (!result?.success) {
          logger.warn(
            { connectionId: conn.id, error: result?.error },
            "Failed to delete one connection in bulk disconnect"
          );
        }
      }

      // Also delete sync logs (service doesn't handle these)
      await prisma.syncLog.deleteMany({
        where: { userId: authUser.userId, broker },
      });
    }

    revalidatePath("/brokers");
    revalidatePath("/holdings");
    revalidatePath("/positions");
    revalidatePath("/tradebook");
    revalidatePath("/mutual-funds");
    revalidatePath("/dashboard");

    // Send broker disconnected email (fire-and-forget, preference-gated)
    if (user) {
      const discPrefs = getEffectivePreferences(user.emailPreferences);
      if (shouldSendEmail(discPrefs, "broker-disconnected")) {
        const unsubUrl = buildUnsubscribeUrl(user.email, "brokerNotifications");
        sendEmail({
          to: user.email,
          subject: `${broker} Broker Disconnected - UseMoney`,
          unsubscribeUrl: unsubUrl,
          react: React.createElement(BrokerDisconnectedEmail, {
            name: user.name || "there",
            brokerName: broker,
            unsubscribeUrl: unsubUrl,
          }),
          template: "broker-disconnected",
        });
      }
    }

    return { success: true };
  } catch (error: unknown) {
    logger.error(
      { error, broker, connectionId, action: "disconnectBrokerAction" },
      "Disconnect error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to disconnect broker"),
    };
  }
}

// ================== Data Sync ==================

// MONEY-839: historical backfill window (days) — configurable, NOT a magic 730.
// 730 (2y) silently lost older history (a 5-year accumulation kept only 2y).
// The Console returns fast for ranges with NO data, so a wide default captures
// full history for essentially all retail accounts at low cost; ops can lower it
// via BROKER_HISTORICAL_SYNC_DAYS. getHistoricalTrades CHUNKS the range so any
// size fetches reliably regardless of the broker's per-request cap.
// MONEY-846: parse+clamp lives in the pure broker-connection-logic sibling so a
// NEGATIVE/NaN/empty override can't silently disable backfill (Number("-5")||3650
// → -5 → fromDate in the FUTURE → the year-loop never ran).
const HISTORICAL_SYNC_DAYS = parseHistoricalSyncDays(
  process.env.BROKER_HISTORICAL_SYNC_DAYS
);

// MONEY-839: pre-create a BackgroundJob row so a published worker job (FIFO
// pairing / historical sync) is POLLABLE by the tradebook loader. The worker
// updates the row by jobId via updateMany — a NO-OP without a pre-existing row —
// so without this the loader had nothing to track. Best-effort: a failed insert
// must never block the publish/sync.
async function trackBrokerJob(
  jobId: string,
  userId: string,
  jobType: "TRADE_PAIRING" | "BROKER_SYNC"
): Promise<void> {
  try {
    await prisma.backgroundJob.create({
      data: {
        jobId,
        userId,
        jobType,
        status: "PENDING",
        progress: 0,
        queuedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ err, jobId, jobType }, "trackBrokerJob: row create failed");
  }
}

/**
 * MONEY-839: does the current user have an in-flight broker SYNC job? Drives the
 * tradebook "syncing…" animated loader so it reflects the REAL async worker
 * progress (day data + historical backfill) instead of a fixed timer. Stale rows
 * (>15 min — e.g. a job that never reported completion) are ignored so the loader
 * can never wedge on "in progress". (Pairing was removed here — MONEY-840.)
 */
export async function getActiveBrokerJobsAction(): Promise<{
  active: boolean;
  phase: "syncing" | null;
}> {
  try {
    if (await isDemoSession()) return { active: false, phase: null };
    const user = await getOrCreateUser();
    if (!user) return { active: false, phase: null };
    const since = staleBrokerJobCutoff();
    const jobs = await prisma.backgroundJob.findMany({
      where: {
        userId: user.id,
        jobType: "BROKER_SYNC",
        status: { in: ["PENDING", "PROCESSING"] },
        queuedAt: { gte: since },
      },
      select: { id: true },
      take: 1,
    });
    if (jobs.length === 0) return { active: false, phase: null };
    return { active: true, phase: "syncing" };
  } catch {
    return { active: false, phase: null };
  }
}

/**
 * MONEY-848: poll a specific broker SYNC job's status + per-type result counts.
 * The brokers-page Sync button polls this (with the jobId returned by
 * syncBrokerDataAction) so it can toast REAL counts on completion instead of a
 * static "Synced" the instant the job is merely PUBLISHED. Ownership-scoped by
 * userId; never throws (the caller treats null as "keep waiting"). The shape of
 * `result` mirrors what the worker stamps via buildSyncJobStatusUpdate
 * ({ success, synced, total }).
 */
export async function getBrokerSyncJobStatusAction(jobId: string): Promise<{
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "UNKNOWN";
  synced?: {
    holdings?: number;
    positions?: number;
    trades?: number;
    mutualFunds?: number;
  };
  total?: number;
  error?: string;
}> {
  try {
    if (await isDemoSession()) return { status: "UNKNOWN" };
    const user = await getOrCreateUser();
    if (!user || !jobId) return { status: "UNKNOWN" };
    const job = await prisma.backgroundJob.findFirst({
      where: { jobId, userId: user.id, jobType: "BROKER_SYNC" },
      select: { status: true, result: true, errorMessage: true },
    });

    // The defensive Json-parse + CANCELLED→FAILED + missing-row→UNKNOWN mapping
    // lives in the pure, unit-tested mapBrokerSyncJobStatus.
    return mapBrokerSyncJobStatus(job);
  } catch {
    return { status: "UNKNOWN" };
  }
}

export async function syncBrokerDataAction(
  broker: BrokerType,
  syncTypes: ("holdings" | "positions" | "trades" | "mutualFunds")[] = [
    "holdings",
    "positions",
    "trades",
    // MONEY-837: MFs sync by default (Zerodha-only; others return []).
    "mutualFunds",
  ],
  connectionId?: string,
  opts?: {
    historicalPending?: boolean;
    isInitialConnect?: boolean;
    /**
     * MONEY-848: when true, ask the worker to send a "Sync Complete" summary
     * email on success (brokers-page manual Sync only). Omitted by the silent
     * refresh callers (holdings/positions/tradebook resync) so they stay quiet.
     */
    syncEmail?: boolean;
  }
): Promise<{
  success: boolean;
  /**
   * MONEY-848: the published worker job's id. The brokers page polls
   * getBrokerSyncJobStatusAction(jobId) to toast real per-type counts on
   * completion (sync is worker-only, so `synced` is never filled in inline).
   */
  jobId?: string;
  synced?: {
    holdings?: number;
    positions?: number;
    trades?: number;
    mutualFunds?: number;
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  // MONEY-837: ZERODHA_CONNECT is token-capture only (paid Connect app) — never
  // synced; the Personal app owns all portfolio sync.
  if (broker === "ZERODHA_CONNECT") {
    return { success: false, error: "Connect app does not sync data." };
  }

  let syncUserId = "";
  try {
    const user = await getOrCreateUser();
    if (!user) {
      return { success: false, error: "Authentication required" };
    }
    syncUserId = user.id;

    // MONEY-837: free-tier gate — after the 30-day trial, sync is disabled
    // until the user upgrades.
    const gate = await getBrokerGate(user.id);
    if (gate.isFree && gate.trialExpired) {
      return {
        success: false,
        error:
          "Your 30-day free trial has ended. Upgrade to Pro to keep syncing your brokers.",
      };
    }

    // MONEY-839: sync is WORKER-ONLY now. This action just PUBLISHES a
    // broker-sync job; the Cloud Run worker (processSync) does the full sync
    // (day data + optional historical backfill), persists, invalidates cache,
    // and — on a connect job — sends the completion email. No inline/app-based
    // sync: it risked the Vercel timeout on large backfills and duplicated the
    // worker. NO pairing in this ticket — that moves to the MONEY-840 redesign.
    // RAG indexing + dashboard precompute on sync also move to the worker
    // (MONEY-842/843). `historicalPending` requests the 730-day backfill;
    // `isInitialConnect` lets the worker send the sync-complete email.
    const jobId = crypto.randomUUID();
    await trackBrokerJob(jobId, user.id, "BROKER_SYNC");
    await publishSyncJob({
      jobId,
      userId: user.id,
      broker,
      brokerConnectionId: connectionId,
      dataTypes: syncTypes,
      ...(opts?.historicalPending
        ? { historicalDays: HISTORICAL_SYNC_DAYS }
        : {}),
      ...(opts?.isInitialConnect ? { historicalEmail: true } : {}),
      // MONEY-848: brokers-page manual Sync requests a confirmation email; the
      // silent refresh callers leave this unset so they don't email.
      ...(opts?.syncEmail ? { syncEmail: true } : {}),
    });

    revalidatePath("/holdings");
    revalidatePath("/positions");
    revalidatePath("/tradebook");
    revalidatePath("/dashboard");

    return { success: true, jobId };
  } catch (error: unknown) {
    logger.error(
      { error, broker, action: "syncBrokerDataAction" },
      "Sync error"
    );
    void recordBrokerFailure({
      userId: syncUserId,
      broker,
      operation: "sync_broker_data",
      error,
    });
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to sync broker data"),
    };
  }
}

/**
 * MONEY-837: backfill the multi-day HISTORICAL tradebook (Zerodha Console /
 * backoffice API; other brokers return []). Defaults to the last 365 days when
 * no range is given. SLOW (async polling) — large ranges should run via the
 * worker; this on-demand action suits a one-off backfill / connect-time pull.
 */
export async function syncHistoricalTradesAction(
  broker: BrokerType,
  fromDate?: string,
  toDate?: string,
  connectionId?: string
): Promise<{ success: boolean; synced?: number; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }
  if (broker === "ZERODHA_CONNECT") {
    return { success: false, error: "Connect app does not sync data." };
  }

  let syncUserId = "";
  try {
    const user = await getOrCreateUser();
    if (!user) {
      return { success: false, error: "Authentication required" };
    }
    syncUserId = user.id;

    // Same free-tier gate as the regular sync: after the 30-day trial, disabled.
    const gate = await getBrokerGate(user.id);
    if (gate.isFree && gate.trialExpired) {
      return {
        success: false,
        error:
          "Your 30-day free trial has ended. Upgrade to Pro to keep syncing your brokers.",
      };
    }

    const to = toDate ? new Date(toDate) : new Date();
    const from = fromDate
      ? new Date(fromDate)
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    const result = await syncHistoricalTradebook({
      userId: user.id,
      broker,
      connectionId,
      fromDate: from,
      toDate: to,
    });
    if (!result.success) {
      return {
        success: false,
        error:
          // MONEY-1379: the constant, not a re-typed literal. The service is
          // the only place that produces this text, and a silent drift between
          // the two spellings would show the raw internal string to a user.
          result.error === NO_CONNECTIONS_ERROR
            ? "Broker not connected"
            : result.error,
      };
    }

    // Surface per-connection failures to the failure log (telemetry).
    for (const conn of result.data.perConnection) {
      if (conn.error && !conn.skipped) {
        void recordBrokerFailure({
          userId: user.id,
          broker,
          operation: "sync_historical_trades",
          error: new Error(conn.error),
        });
      }
    }

    if (result.data.synced > 0) {
      // MONEY-839: pairing moved to the MONEY-840 redesign. Just refresh caches
      // so the backfilled history shows in the tradebook.
      await clearBrokerSyncCache(user.id);
      revalidatePath("/tradebook");
      revalidatePath("/dashboard");
    }

    return { success: true, synced: result.data.synced };
  } catch (error: unknown) {
    logger.error(
      { error, broker, action: "syncHistoricalTradesAction" },
      "Historical tradebook sync error"
    );
    void recordBrokerFailure({
      userId: syncUserId,
      broker,
      operation: "sync_historical_trades",
      error,
    });
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to sync historical trades"),
    };
  }
}

/**
 * Diagnose MF trade pairing issues
 * Returns details about MF trades and their ISIN status
 */
export async function diagnoseMFPairingAction(): Promise<{
  success: boolean;
  error?: string;
  diagnosis?: {
    totalMFTrades: number;
    tradesWithIsin: number;
    tradesWithoutIsin: number;
    uniqueSymbols: number;
    uniqueIsins: number;
    symbolsWithoutIsin: string[];
    suggestedFix: string;
  };
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const user = await getOrCreateUser();
  if (!user) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Only the symbol / tradingSymbol / isin projection feeds the pure diagnosis.
    const mfTrades = await prisma.trade.findMany({
      where: { userId: user.id, segment: "MF" },
      select: { symbol: true, tradingSymbol: true, isin: true },
    });

    // Counts + suggested-fix are the pure @usemoney/services seam.
    return { success: true, diagnosis: diagnoseMFPairing(mfTrades) };
  } catch (error: unknown) {
    logger.error({ error }, "Error diagnosing MF pairing");
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to diagnose MF pairing"),
    };
  }
}

/**
 * Trigger re-pairing for all user trades
 */
export async function triggerRepairingAction(): Promise<{
  success: boolean;
  paired?: number;
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const user = await getOrCreateUser();
  if (!user) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // MONEY-840: pairing is back ON. This action PUBLISHES a trade-pairing job to
    // the Cloud Run worker (processPairing), which does a full FIFO re-pair over
    // the user's complete trade history and rewrites the persisted
    // PairedTradeView (the tradebook's source for CLOSED/OPEN/PARTIAL + realised
    // P&L). Pairing is worker-only — a full re-pair can be heavy and would risk
    // the Vercel timeout if run inline. We pre-create a BackgroundJob row so the
    // job is pollable (the worker updates it by jobId via updateMany, a no-op
    // without a pre-existing row). The result is async, so `paired` stays 0 here
    // for backward-compat with the admin callers (they only check `success`).
    const jobId = crypto.randomUUID();
    await trackBrokerJob(jobId, user.id, "TRADE_PAIRING");
    await publishPairingJob({ jobId, userId: user.id });
    revalidatePath("/tradebook");
    return { success: true, paired: 0 };
  } catch (error: unknown) {
    logger.error({ error }, "Error triggering re-pairing");
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to trigger re-pairing"),
    };
  }
}

/**
 * Populate ISIN for existing MF trades and trigger re-pairing
 * For Mutual Funds, the tradingSymbol IS the ISIN (e.g., INF277K01QO1)
 * This is needed to fix pairing for trades imported before ISIN support was added
 */
export async function populateMFISINAction(): Promise<{
  success: boolean;
  updated: number;
  paired?: number;
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      updated: 0,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const user = await getOrCreateUser();
  if (!user) {
    return { success: false, updated: 0, error: "Unauthorized" };
  }

  try {
    let updated = 0;

    // ## MONEY-1236 — "no ISIN yet" is TWO shapes on Mongo, not one
    //
    // All three strategies below select their work with `isin: null`. Prisma's
    // MongoDB connector compiles that to an equality against a STORED null, so
    // it cannot reach a document where the key is ABSENT — the shape a writer
    // produces by simply omitting the field. `{ isSet: false }` (or a raw
    // `$exists: false`) is the only predicate that does. Same defect class as
    // MONEY-1050 / MONEY-1205 / MONEY-1234 / MONEY-1235.
    //
    // Measured on PROD 2026-08-21, `trades`, so the size of this one is on the
    // record rather than assumed:
    //
    //     total                36,933
    //     isin explicit null   12,987   <- `{ isin: null }` DOES select these
    //     isin ABSENT              28   (0.1%)  <- invisible until now
    //     isin set             23,918
    //     source = "SYNCED"         0   (no synced trades exist at all)
    //
    // This is a CORRECTNESS fix, not a rescue: unlike the two other MONEY-1236
    // sites, this repair was already reaching the bulk of its population. The
    // 28 absent-ISIN trades are the entire blast radius, and any claim that the
    // repair "operates on an empty set", or that it is broken for synced
    // trades, does not survive those numbers.
    //
    // The companion `{ isin: { not: null } }` selector further down is left
    // exactly as it is: there the absent rows MUST be excluded (a row with no
    // `isin` key is not a reference row), which is what `$ne: null` already
    // does on Mongo, where a missing field compares equal to null.
    //
    // Strategy 1: MF trades where tradingSymbol looks like an ISIN (INF...)
    const mfTradesWithIsinTradingSymbol = await prisma.trade.findMany({
      where: {
        userId: user.id,
        segment: "MF",
        OR: [{ isin: null }, { isin: { isSet: false } }],
        tradingSymbol: { startsWith: "INF" },
      },
      select: {
        id: true,
        tradingSymbol: true,
        symbol: true,
      },
    });

    for (const trade of mfTradesWithIsinTradingSymbol) {
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          isin: trade.tradingSymbol,
          needsRepairing: true,
        },
      });
      updated++;
    }

    // Strategy 2: MF trades where symbol looks like an ISIN (INF...)
    // MONEY-1236: same two-shape selector as Strategy 1 — see the block above.
    const mfTradesWithIsinSymbol = await prisma.trade.findMany({
      where: {
        userId: user.id,
        segment: "MF",
        OR: [{ isin: null }, { isin: { isSet: false } }],
        symbol: { startsWith: "INF" },
      },
      select: {
        id: true,
        symbol: true,
      },
    });

    for (const trade of mfTradesWithIsinSymbol) {
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          isin: trade.symbol,
          needsRepairing: true,
        },
      });
      updated++;
    }

    // Strategy 3+4: resolve remaining no-ISIN trades against the reference
    // trades that DO carry an ISIN — exact symbol/tradingSymbol, then
    // exact-normalised fund name, then a fuzzy (Jaccard ≥ 0.8) fallback. The map
    // build + per-trade matching are the pure @usemoney/services diagnostics seam
    // (matchIsinForTrade applies the SAME precedence the two inline strategies did).
    // MONEY-1236: same two-shape selector as Strategy 1 — see the block above.
    const mfTradesNoIsin = await prisma.trade.findMany({
      where: {
        userId: user.id,
        segment: "MF",
        OR: [{ isin: null }, { isin: { isSet: false } }],
      },
      select: { id: true, symbol: true, tradingSymbol: true },
    });
    const mfTradesWithIsin = await prisma.trade.findMany({
      where: { userId: user.id, segment: "MF", isin: { not: null } },
      select: { symbol: true, tradingSymbol: true, isin: true },
    });

    if (mfTradesNoIsin.length > 0 && mfTradesWithIsin.length > 0) {
      const isinMaps = buildIsinMap(mfTradesWithIsin);
      for (const trade of mfTradesNoIsin) {
        const isin = matchIsinForTrade(trade, isinMaps);
        if (isin) {
          await prisma.trade.update({
            where: { id: trade.id },
            data: { isin, needsRepairing: true },
          });
          updated++;
        }
      }
    }

    // MONEY-839: pairing moved to the MONEY-840 redesign — no re-pair here.
    const paired = 0;

    // Revalidate tradebook
    revalidatePath("/tradebook");

    return { success: true, updated, paired };
  } catch (error: unknown) {
    logger.error({ error }, "Error populating MF ISIN");
    return {
      success: false,
      updated: 0,
      error: getSafeErrorMessage(error, "Failed to populate MF ISIN"),
    };
  }
}

/**
 * Sync all connected brokers for the current user.
 * Called from holdings/positions refresh buttons.
 */
export async function syncAllBrokersAction(): Promise<{
  success: boolean;
  results?: { broker: string; success: boolean; error?: string }[];
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const user = await getOrCreateUser();
    if (!user) return { success: false, error: "Authentication required" };

    const connections = await prisma.brokerConnection.findMany({
      where: { userId: user.id },
      select: { id: true, broker: true },
    });

    if (connections.length === 0) {
      return { success: true, results: [] };
    }

    const results = await Promise.allSettled(
      connections.map(async (conn) => {
        const result = await syncBrokerDataAction(
          conn.broker as BrokerType,
          ["holdings", "positions", "trades", "mutualFunds"],
          conn.id
        );
        return {
          broker: conn.broker,
          success: result?.success,
          error: result?.error,
        };
      })
    );

    return {
      success: true,
      results: results.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { broker: "unknown", success: false, error: "Sync failed" }
      ),
    };
  } catch (error: unknown) {
    logger.error({ error, action: "syncAllBrokersAction" }, "Sync all error");
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to sync brokers"),
    };
  }
}
