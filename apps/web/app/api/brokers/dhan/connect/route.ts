/**
 * Dhan API Key Connection Route
 * Dhan uses API key authentication instead of OAuth
 */

import { NextRequest, NextResponse } from "next/server";
import { connectWithApiKeyAction } from "@/lib/actions/broker-connection";
import { syncLogger as logger } from "@usemoney/logger";
import { recordBrokerFailure } from "@/lib/brokers/failure-log";

export async function POST(request: NextRequest) {
  try {
    const { clientId, accessToken } = await request.json();

    if (!clientId || !accessToken) {
      return NextResponse.json(
        { error: "Client ID and Access Token are required" },
        { status: 400 }
      );
    }

    const result = await connectWithApiKeyAction("DHAN", clientId, accessToken);

    if (result.success) {
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
  } catch (error: unknown) {
    logger.error({ error, broker: "DHAN" }, "Dhan connection error");
    void recordBrokerFailure({
      userId: "",
      broker: "DHAN",
      operation: "connect",
      error,
    });
    return NextResponse.json({ error: "Connection failed" }, { status: 500 });
  }
}
