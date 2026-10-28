/**
 * Tool Execution API Endpoint
 *
 * Dedicated endpoint for confirmed write actions.
 * Does NOT consume AI query credits.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { getOrCreateDbUser } from "@/lib/db/user";
import { executeConfirmedTool } from "@/lib/chat-tools/executor";
import { getTool } from "@/lib/chat-tools/registry";
import { buildListToolBlocks } from "@/lib/chat/tool-result-blocks";
import { deterministicToolSummary } from "@/lib/chat/tool-narration";
import { geminiLogger as logger } from "@usemoney/logger";
import type { ContentBlock } from "@usemoney/types";
import {
  validateExecuteToolRequest,
  isValidConfirmActionId,
  WRITE_CONFIRM_TOOLS,
  NARRATIVE_TOOLS,
  shouldRenderResultBlocks,
} from "./route-logic";

/**
 * POST /api/chat/execute-tool
 *
 * Execute a confirmed tool action
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    // 1. Authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    // 2. Parse request
    const body = await request.json();
    const { tool: toolName, params, actionId } = body;

    const bodyCheck = validateExecuteToolRequest(body);
    if (!bodyCheck.valid) {
      return NextResponse.json({ error: bodyCheck.error }, { status: 400 });
    }

    // 3. Validate actionId format (must be a confirm-UUID from the chat route)
    if (!isValidConfirmActionId(actionId)) {
      return NextResponse.json(
        { error: "Invalid actionId format" },
        { status: 400 }
      );
    }

    // 4. Verify tool exists and requires confirmation
    const tool = getTool(toolName);
    if (!tool) {
      return NextResponse.json(
        { error: "This action is not available. Please try again." },
        { status: 400 }
      );
    }

    // 5. Get database user
    const dbUser = await getOrCreateDbUser(userId);
    if (!dbUser) {
      return NextResponse.json(
        { error: "Failed to resolve user" },
        { status: 500 }
      );
    }

    logger.info(
      { requestId, userId, toolName, actionId },
      "Executing confirmed tool action"
    );

    // 6. Execute the tool
    const result = await executeConfirmedTool(
      toolName,
      params || {},
      dbUser.id
    );

    logger.info(
      {
        requestId,
        userId,
        toolName,
        actionId,
        success: result.success,
      },
      "Tool execution completed"
    );

    // Format the result into rendered blocks server-side so a chip-dispatched
    // read tool (e.g. run_screener) shows its list/cards without an LLM call -
    // the client only had a generic "Here are the results" text fallback, which
    // silently dropped screener rows (MONEY-587). Deterministic: no LLM.
    // Async tools (research / roast / scan) return a sessionId/scanId and the
    // client polls them - don't render terminal blocks for those here
    // (POLLED_TOOLS / WRITE_CONFIRM_TOOLS live in ./route-logic).
    let blocks: ContentBlock[] | undefined;
    let responseText: string | undefined;
    if (shouldRenderResultBlocks(toolName, result.success)) {
      // Render the result deterministically (no LLM) via the shared formatter,
      // so a chip-dispatched read tool shows its list/cards. Previously the
      // client only had a generic "Here are the results" fallback that silently
      // dropped the rows (MONEY-587).
      const listBlocks = buildListToolBlocks(toolName, result.data);
      if (
        listBlocks.length > 0 ||
        WRITE_CONFIRM_TOOLS.has(toolName) ||
        NARRATIVE_TOOLS.has(toolName)
      ) {
        responseText = deterministicToolSummary(toolName, result.data);
        blocks = [{ type: "text", content: responseText }, ...listBlocks];
      }
    }

    return NextResponse.json({
      success: result.success,
      data: result.data,
      error: result.error,
      actionId,
      ...(blocks ? { blocks } : {}),
      ...(responseText ? { response: responseText } : {}),
    });
  } catch (error) {
    logger.error({ requestId, error }, "Tool execution API error");

    return NextResponse.json(
      { error: "Failed to execute action. Please try again." },
      { status: 500 }
    );
  }
}
