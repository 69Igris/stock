/**
 * Groww Connection Route
 *
 * Groww Trade API uses API Key + SHA256(api_secret + timestamp) checksum
 * or API Key + TOTP for authentication. NOT OAuth2.
 *
 * Token endpoint: POST https://api.groww.in/v1/token/api/access
 *   Header: Authorization: Bearer {API_KEY}
 *   Body (approval): { key_type: "approval", checksum: SHA256(secret+ts), timestamp: ts }
 *   Body (TOTP):     { key_type: "totp", totp: "123456" }
 *
 * Token expires daily at 6AM IST. No refresh token.
 *
 * API docs: https://groww.in/trade-api/docs
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getOrCreateDbUser } from "@/lib/db/user";
import { encryption } from "@usemoney/security/encryption";
import { persistBrokerConnection } from "@usemoney/services";
import prisma from "@/lib/prisma";
import { syncLogger as logger } from "@usemoney/logger";
import { recordBrokerFailure } from "@/lib/brokers/failure-log";
import { revalidatePath } from "next/cache";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate user
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return NextResponse.json(
        { error: "Failed to resolve user" },
        { status: 500 }
      );
    }

    // 2. Parse request body - either TOTP or approval (checksum) flow
    const body = await request.json();
    const { apiKey, apiSecret, totp } = body as {
      apiKey?: string;
      apiSecret?: string;
      totp?: string;
    };

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: "API Key and API Secret are required" },
        { status: 400 }
      );
    }

    // 3. Generate access token via Groww Token API
    const timestamp = Math.floor(Date.now() / 1000);
    let tokenBody: Record<string, string | number>;

    if (totp) {
      // TOTP flow - user provides 6-digit code from Groww app
      tokenBody = { key_type: "totp", totp };
    } else {
      // Approval/checksum flow - requires daily approval in Groww app
      const checksum = crypto
        .createHash("sha256")
        .update(apiSecret + timestamp.toString())
        .digest("hex");
      tokenBody = { key_type: "approval", checksum, timestamp };
    }

    const tokenResponse = await fetch(
      "https://api.groww.in/v1/token/api/access",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-API-VERSION": "1.0",
        },
        body: JSON.stringify(tokenBody),
      }
    );

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      logger.warn(
        { userId: dbUser.id, status: tokenResponse.status, error: errText },
        "Groww token exchange failed"
      );
      void recordBrokerFailure({
        userId: dbUser.id,
        broker: "GROWW",
        operation: "connect",
        error: new Error(
          `Groww token exchange failed (HTTP ${tokenResponse.status})`
        ),
      });
      return NextResponse.json(
        {
          error:
            tokenResponse.status === 401
              ? "Invalid API credentials. Please check your API Key and Secret."
              : "Unable to connect to Groww. Please try again later.",
        },
        { status: 400 }
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.token;

    if (!accessToken) {
      return NextResponse.json(
        { error: "No token returned from Groww" },
        { status: 400 }
      );
    }

    // Token expires at 6AM IST next day (~00:30 UTC)
    const tokenExpiry = new Date();
    tokenExpiry.setDate(tokenExpiry.getDate() + 1);
    tokenExpiry.setUTCHours(0, 30, 0, 0);

    const brokerUserId =
      tokenData.sessionName || `groww_${dbUser.id.slice(-6)}`;
    const accountName = `Groww - ${brokerUserId}`;

    // 4/5. Persist via the shared upsert service. Groww credentials =
    // { accessToken, apiKey, apiSecret }, 6AM-IST expiry; single-account, so the
    // existing row is matched by { userId, broker } (the session-derived
    // brokerUserId is not stable across logins — keying on it would spawn dups).
    const persisted = await persistBrokerConnection(
      {
        userId: dbUser.id,
        broker: "GROWW",
        credentials: { accessToken, apiKey, apiSecret },
        tokenExpiry,
        brokerUserId,
        accountName,
        metadata: { sessionName: tokenData.sessionName },
        matchByBrokerUserId: false,
        // Preserve pre-MONEY-1062 behavior: Groww never stamped a syncBucket
        // (excluded from the daily fan-out). MONEY-1066 tracks bringing it in.
        assignSyncBucket: false,
      },
      { prisma, encryption }
    );
    if (!persisted.success) {
      void recordBrokerFailure({
        userId: dbUser.id,
        broker: "GROWW",
        operation: "connect",
        error: new Error(persisted.error),
      });
      return NextResponse.json({ error: "Connection failed" }, { status: 500 });
    }

    revalidatePath("/brokers");

    logger.info(
      { userId: dbUser.id, broker: "GROWW" },
      "Groww connected successfully"
    );

    return NextResponse.json({
      success: true,
      message: "Connected to Groww successfully",
    });
  } catch (error: unknown) {
    logger.error({ error }, "Groww connection error");
    void recordBrokerFailure({
      userId: "",
      broker: "GROWW",
      operation: "connect",
      error,
    });
    return NextResponse.json({ error: "Connection failed" }, { status: 500 });
  }
}
