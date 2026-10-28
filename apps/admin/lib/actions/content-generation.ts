"use server";

import { requireAdmin } from "@/lib/auth";
import { runContentAction } from "./content-generation-logic";

export async function generateContentAction(input: {
  topic: string;
  contentType: "article" | "video" | "audio" | "infographic";
  language?: string;
  rawMaterials?: string;
}) {
  await requireAdmin();
  return runContentAction(async () => {
    const { generateLearningContent } =
      await import("@usemoney/content-engine");
    return generateLearningContent(input);
  }, "Content generation failed");
}

export async function verifyContentAction(input: {
  content: string;
  topic: string;
  contentType: string;
  language?: string;
}) {
  await requireAdmin();
  return runContentAction(async () => {
    const { verifyContent } = await import("@usemoney/content-engine");
    return verifyContent(input);
  }, "Content verification failed");
}
