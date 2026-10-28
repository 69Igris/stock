/** Google Cloud Text-to-Speech (Hindi + English). Runs in your env (GCP creds). */
import textToSpeech from "@google-cloud/text-to-speech";
import { writeFile } from "node:fs/promises";
import type { Voiceover } from "../types.js";

const client = new textToSpeech.TextToSpeechClient();

export function defaultVoice(lang: string): string {
  if (lang === "hi-IN") return process.env.TTS_VOICE_HI ?? "hi-IN-Neural2-A";
  if (lang.startsWith("en"))
    return process.env.TTS_VOICE_EN ?? "en-IN-Neural2-A";
  return process.env.TTS_VOICE_EN ?? "en-IN-Neural2-A";
}

/** Synthesize a voiceover line to an MP3. Returns the path. */
export async function synthesizeVoiceover(
  vo: Voiceover,
  outMp3: string,
): Promise<string> {
  const lang = vo.lang ?? "hi-IN";
  const name = vo.voice ?? defaultVoice(lang);
  const [resp] = await client.synthesizeSpeech({
    input: { text: vo.text },
    voice: { languageCode: lang, name },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: Number(process.env.TTS_SPEAKING_RATE ?? 1),
    },
  });
  if (!resp.audioContent) throw new Error("Google TTS returned no audio.");
  await writeFile(outMp3, resp.audioContent as Uint8Array);
  return outMp3;
}
