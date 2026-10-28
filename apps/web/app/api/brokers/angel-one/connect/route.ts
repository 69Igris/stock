/**
 * Angel One SmartAPI Connection Route
 *
 * TOTP-based auth: POST /rest/auth/angelbroking/user/v1/loginByPassword
 * with { clientcode, password, totp }.
 *
 * Token expires at midnight IST but CAN be refreshed via
 * POST /rest/auth/angelbroking/jwt/v1/generateTokens with the
 * refreshToken - no TOTP required for refresh (verified 2026-04-09
 * against official Python/Node SDKs).
 *
 * API docs: https://smartapi.angelone.in/docs
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

const SMART_API_BASE = "https://apiconnect.angelone.in";

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

    // 2. Parse request body
    const { clientCode, password, totp } = await request.json();

    if (!clientCode || !password || !totp) {
      return NextResponse.json(
        { error: "Client code, password, and TOTP are required" },
        { status: 400 }
      );
    }

    // 3. Authenticate with Angel One SmartAPI
    const apiKey = process.env.ANGEL_API_KEY || "";

    const loginResponse = await fetch(
      `${SMART_API_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-UserType": "USER",
          "X-SourceID": "WEB",
          "X-ClientLocalIP": "127.0.0.1",
          "X-ClientPublicIP": "127.0.0.1",
          "X-MACAddress": "00:00:00:00:00:00",
          "X-PrivateKey": apiKey,
        },
        body: JSON.stringify({
          clientcode: clientCode,
          password,
          totp,
        }),
      }
    );

    const loginData = await loginResponse.json();

    if (!loginData.status || !loginData.data?.jwtToken) {
      logger.warn(
        {
          userId: dbUser.id,
          status: loginData.status,
          message: loginData.message,
        },
        "Angel One authentication failed"
      );
      void recordBrokerFailure({
        userId: dbUser.id,
        broker: "ANGEL_ONE",
        operation: "connect",
        error: new Error(
          loginData.message
            ? String(loginData.message)
            : "Angel One authentication failed"
        ),
      });
      // Don't leak raw API error messages to the UI - log them server-side
      return NextResponse.json(
        {
          error:
            "Authentication failed. Please check your Client Code, Password, and TOTP.",
        },
        { status: 400 }
      );
    }

    const accessToken = loginData.data.jwtToken;
    const refreshToken = loginData.data.refreshToken;

    // Token expires at midnight IST (~18:30 UTC)
    const tokenExpiry = new Date();
    tokenExpiry.setUTCHours(18, 30, 0, 0);
    if (tokenExpiry < new Date()) {
      // Already past midnight IST - set to tomorrow
      tokenExpiry.setDate(tokenExpiry.getDate() + 1);
    }

    const brokerUserId = clientCode;
    const accountName = `Angel One - ${clientCode}`;

    // 4/5. Persist via the shared upsert service. Angel One credentials =
    // { accessToken, refreshToken, apiKey, userId: clientCode }, midnight-IST
    // expiry; multi-account, so the existing row is matched by
    // { userId, broker, brokerUserId }.
    const persisted = await persistBrokerConnection(
      {
        userId: dbUser.id,
        broker: "ANGEL_ONE",
        credentials: { accessToken, refreshToken, apiKey, userId: clientCode },
        tokenExpiry,
        brokerUserId,
        accountName,
        metadata: { clientCode },
        // Preserve pre-MONEY-1062 behavior: Angel One never stamped a
        // syncBucket (excluded from the daily fan-out). MONEY-1066 tracks it.
        assignSyncBucket: false,
      },
      { prisma, encryption }
    );
    if (!persisted.success) {
      void recordBrokerFailure({
        userId: dbUser.id,
        broker: "ANGEL_ONE",
        operation: "connect",
        error: new Error(persisted.error),
      });
      return NextResponse.json({ error: "Connection failed" }, { status: 500 });
    }

    revalidatePath("/brokers");

    logger.info(
      { userId: dbUser.id, broker: "ANGEL_ONE", clientCode },
      "Angel One connected successfully"
    );

    return NextResponse.json({
      success: true,
      message: "Connected to Angel One successfully",
    });
  } catch (error: unknown) {
    logger.error({ error }, "Angel One connection error");
    void recordBrokerFailure({
      userId: "",
      broker: "ANGEL_ONE",
      operation: "connect",
      error,
    });
    return NextResponse.json({ error: "Connection failed" }, { status: 500 });
  }
}
