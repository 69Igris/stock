/**
 * Veo (Google's text-to-video) via Vertex AI, using the same @google/genai SDK
 * the repo already uses. RUNS IN YOUR ENV (needs GCP creds + network) — not in
 * the Cowork sandbox.
 *
 * NOTE: Veo's API surface + model ids evolve. Verify `VEO_MODEL` and the method
 * names against your installed @google/genai version (^2.8). The flow is always:
 * start a long-running op → poll until done → download the resulting MP4.
 */
import { GoogleGenAI } from "@google/genai";
import { writeFile } from "node:fs/promises";
import type { Scene, Timeline } from "../types.js";

/**
 * Veo generates discrete clip lengths only (4/6/8s). Requesting an unsupported
 * value (e.g. 5 or 7) silently returns no video, so snap to the nearest valid one.
 */
export function veoDurationSeconds(sec: number): number {
  return sec < 5 ? 4 : sec < 7 ? 6 : 8;
}

export async function generateVeoClip(
  scene: Scene,
  tl: Timeline,
  outMp4: string,
): Promise<void> {
  if (!scene.veoPrompt)
    throw new Error(`veo scene ${scene.id} needs a veoPrompt`);
  const project = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION ?? "us-central1";
  if (!project) throw new Error("GCP_PROJECT_ID is required for Veo (Vertex).");

  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const model = process.env.VEO_MODEL ?? "veo-3.0-generate-001";
  const aspectRatio = tl.aspect === "16:9" ? "16:9" : "9:16"; // Veo supports 16:9 and 9:16

  let op = await ai.models.generateVideos({
    model,
    prompt: scene.veoPrompt,
    config: {
      aspectRatio,
      numberOfVideos: 1,
      durationSeconds: veoDurationSeconds(scene.durationSec),
      // The editor strips Veo audio (-an) and muxes its own voiceover + music,
      // so generating audio would only add cost — turn it off.
      generateAudio: false,
      // SEBI-safe: Veo is for abstract B-roll only, never AI "presenters".
      personGeneration: "dont_allow",
    },
  });

  // Poll the long-running operation.
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    op = await ai.operations.getVideosOperation({ operation: op });
  }

  const generated = op.response?.generatedVideos;
  if (!generated || generated.length === 0)
    throw new Error("Veo returned no video (check quota / prompt / model id).");
  const video = generated[0]?.video;
  if (!video) throw new Error("Veo response missing video payload.");

  // Vertex returns the clip inline in `videoBytes`. With @google/genai it is a
  // base64-encoded STRING (must be decoded before writing); some SDK builds use a
  // Uint8Array instead. Otherwise fall back to a downloadable file ref.
  const inline = (video as { videoBytes?: string | Uint8Array }).videoBytes;
  if (inline) {
    const buf =
      typeof inline === "string"
        ? Buffer.from(inline, "base64")
        : Buffer.from(inline);
    await writeFile(outMp4, buf);
    return;
  }
  await ai.files.download({ file: video, downloadPath: outMp4 });
}
