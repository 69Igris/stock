"use server";

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import { getGeminiModel, generateWithTimeout } from "@/lib/gemini/models";

export async function getOrGenerateDescriptionAction(
  symbol: string,
  exchange: string
): Promise<{ success: boolean; description?: string; error?: string }> {
  try {
    // Try cache first
    const filters = { symbol, exchange };
    const cached = await getCached<string>(
      "instrument",
      "_global",
      "description",
      filters
    );
    if (cached) {
      return { success: true, description: cached };
    }

    const instrument = await prisma.instrumentMapping.findFirst({
      where: { symbol, exchange, isActive: true },
      select: { id: true, description: true, name: true, sector: true },
    });

    // Already has a description - return it and cache
    if (instrument?.description) {
      await setCached(
        "instrument",
        "_global",
        "description",
        instrument.description,
        filters
      );
      return { success: true, description: instrument.description };
    }

    // Generate via Gemini Flash (works with or without DB record)
    const model = getGeminiModel("fast");
    const name = instrument?.name ?? symbol;
    const sector = instrument?.sector ?? "listed";
    const prompt = `Write a 2-3 sentence investment description for ${name} (${symbol}), a ${sector} company on ${exchange}. Focus on what the company does and its market position. Keep it factual and concise.`;

    const description = await generateWithTimeout(model, prompt, 15000);

    // Persist if we have a DB record
    if (instrument) {
      await prisma.instrumentMapping.update({
        where: { id: instrument.id },
        data: { description },
      });
    }

    // Cache the generated description
    await setCached(
      "instrument",
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
