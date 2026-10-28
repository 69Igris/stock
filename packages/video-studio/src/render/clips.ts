/** Render a scene into a silent, normalized video clip. Audio is assembled later in compose. */
import { chromium, type Browser } from "playwright";
import { ffmpeg } from "../ffmpeg.js";
import { captionHtml, sceneHtml } from "../brand/scene.js";
import { DIMENSIONS, type Scene, type Timeline } from "../types.js";

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!_browser) {
    // In containers (e.g. the Cloud Run worker on Alpine) Playwright's bundled
    // Chromium isn't available; point it at the system chromium via
    // PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Unset = Playwright default (local).
    // --no-sandbox / --disable-dev-shm-usage are required for Chromium-as-root
    // in a container; harmless locally.
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    _browser = await chromium.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return _browser;
}
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

export async function captureSceneFrame(
  scene: Scene,
  tl: Timeline,
  outPng: string,
): Promise<void> {
  const html = sceneHtml(scene, tl);
  if (!html)
    throw new Error(`scene ${scene.id} (${scene.type}) has no HTML frame`);
  const { w, h } = DIMENSIONS[tl.aspect];
  const page = await (
    await getBrowser()
  ).newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await (document as unknown as { fonts: { ready: Promise<unknown> } })
        .fonts.ready;
    });
    await page.screenshot({ path: outPng });
  } finally {
    await page.close();
  }
}

/** Render a transparent caption layer (one line) to a PNG for overlay onto a clip. */
export async function captionPng(
  text: string,
  tl: Timeline,
  outPng: string,
): Promise<void> {
  const { w, h } = DIMENSIONS[tl.aspect];
  const page = await (
    await getBrowser()
  ).newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  try {
    await page.setContent(captionHtml(text, tl), { waitUntil: "load" });
    await page.evaluate(async () => {
      await (document as unknown as { fonts: { ready: Promise<unknown> } })
        .fonts.ready;
    });
    await page.screenshot({ path: outPng, omitBackground: true });
  } finally {
    await page.close();
  }
}

function motionVf(scene: Scene, tl: Timeline, frames: number): string {
  const { w, h } = DIMENSIONS[tl.aspect];
  const up = `scale=${Math.round(w * 1.25)}:${Math.round(h * 1.25)}`;
  const c = `iw/2-(iw/zoom/2)`,
    m = `ih/2-(ih/zoom/2)`;
  let zp: string;
  switch (scene.motion) {
    case "kenburns-in":
      zp = `zoompan=z='min(zoom+0.0009,1.12)':d=${frames}:x='${c}':y='${m}'`;
      break;
    case "kenburns-out":
      zp = `zoompan=z='if(eq(on,0),1.12,max(zoom-0.0009,1.0))':d=${frames}:x='${c}':y='${m}'`;
      break;
    case "pan-left":
      zp = `zoompan=z=1.12:d=${frames}:x='(iw-iw/zoom)*(1-on/${frames})':y='${m}'`;
      break;
    case "pan-right":
      zp = `zoompan=z=1.12:d=${frames}:x='(iw-iw/zoom)*(on/${frames})':y='${m}'`;
      break;
    default:
      zp = `zoompan=z=1.001:d=${frames}:x='${c}':y='${m}'`; // static-ish
  }
  zp += `:s=${w}x${h}:fps=${tl.fps}`;
  const dur = frames / tl.fps;
  const fade = `fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, dur - 0.3).toFixed(2)}:d=0.3`;
  return `${up},${zp},${fade},format=yuv420p`;
}

/** Animated/branded graphics scene → clip (still frame + ffmpeg motion). */
export async function stillToClip(
  png: string,
  scene: Scene,
  tl: Timeline,
  outMp4: string,
): Promise<void> {
  const frames = Math.max(1, Math.round(scene.durationSec * tl.fps));
  await ffmpeg([
    "-loop",
    "1",
    "-i",
    png,
    "-t",
    String(scene.durationSec),
    "-r",
    String(tl.fps),
    "-vf",
    motionVf(scene, tl, frames),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-an",
    outMp4,
  ]);
}

/** Imported media (screen recording / talking head / Veo output) → normalized silent clip. */
export async function mediaToClip(
  src: string,
  scene: Scene,
  tl: Timeline,
  outMp4: string,
): Promise<void> {
  const { w, h } = DIMENSIONS[tl.aspect];
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${tl.fps},format=yuv420p`;
  await ffmpeg([
    "-i",
    src,
    "-t",
    String(scene.durationSec),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-an",
    outMp4,
  ]);
}
