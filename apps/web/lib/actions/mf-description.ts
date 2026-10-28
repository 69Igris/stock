"use server";

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import { getGeminiModel, generateWithTimeout } from "@/lib/gemini/models";

export async function getOrGenerateMfDescriptionAction(
  schemeCode: string
): Promise<{ success: boolean; description?: string; error?: string }> {
  try {
    // Try cache first
    const filters = { schemeCode };
    const cached = await getCached<string>(
      "mf-metadata",
      "_global",
      "description",
      filters
    );
    if (cached) {
      return { success: true, description: cached };
    }

    const fund = await prisma.mutualFundMaster.findUnique({
      where: { schemeCode },
      select: {
        id: true,
        description: true,
        schemeName: true,
        amcName: true,
        category: true,
        plan: true,
      },
    });

    // Already has a description - return and cache it
    if (fund?.description) {
      await setCached(
        "mf-metadata",
        "_global",
        "description",
        fund.description,
        filters
      );
      return { success: true, description: fund.description };
    }

    // Generate via Gemini Flash
    const model = getGeminiModel("fast");
    const name = fund?.schemeName ?? `Mutual Fund (${schemeCode})`;
    const amc = fund?.amcName ?? "Unknown AMC";
    const category = fund?.category ?? "mutual fund";
    const plan = fund?.plan ?? "";

    const prompt = `Write a 2-3 sentence description for the Indian mutual fund "${name}" by ${amc}. It is a ${category}${plan ? ` (${plan} plan)` : ""} fund. Focus on the fund's investment objective, strategy, and who it's suitable for. Keep it factual and concise. Do not include disclaimers.`;

    const description = await generateWithTimeout(model, prompt, 15000);

    // Persist to DB
    if (fund) {
      await prisma.mutualFundMaster.update({
        where: { id: fund.id },
        data: { description },
      });
    }

    // Cache
    await setCached(
      "mf-metadata",
      "_global",
      "description",
      description,
      filters
    );

    return { success: true, description };
  } catch {
    return { success: false, error: "Failed to generate description" };
  }
}
