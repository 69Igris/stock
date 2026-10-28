/** Compile a Scene into a full, brand-exact HTML document for frame capture. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIMENSIONS, type Scene, type Timeline } from "../types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const BRAND_CSS = readFileSync(
  process.env.BRAND_CSS ? process.env.BRAND_CSS : join(__dir, "um-brand.css"),
  "utf8",
);

/** Try bundled @fontsource (offline, brand-exact); fall back to Google Fonts. */
function fontCss(): string {
  try {
    const url = (pkg: string, file: string) =>
      pathToFileURL(require.resolve(`${pkg}/files/${file}`)).href;
    const face = (
      family: string,
      weight: number,
      src: string,
      italic = false,
    ) =>
      `@font-face{font-family:'${family}';font-weight:${weight};font-style:${italic ? "italic" : "normal"};src:url('${src}')}`;
    return [
      ...[400, 600, 700, 800, 900].map((w) =>
        face(
          "Inter",
          w,
          url("@fontsource/inter", `inter-latin-${w}-normal.woff2`),
        ),
      ),
      ...[600, 700, 800].map((w) =>
        face(
          "JetBrains Mono",
          w,
          url(
            "@fontsource/jetbrains-mono",
            `jetbrains-mono-latin-${w}-normal.woff2`,
          ),
        ),
      ),
      face(
        "Instrument Serif",
        400,
        url(
          "@fontsource/instrument-serif",
          "instrument-serif-latin-400-normal.woff2",
        ),
      ),
      face(
        "Instrument Serif",
        400,
        url(
          "@fontsource/instrument-serif",
          "instrument-serif-latin-400-italic.woff2",
        ),
        true,
      ),
    ].join("\n");
  } catch {
    return `@import url("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@600;700;800&family=Inter:wght@400;600;700;800;900&display=swap");`;
  }
}

/** *word* -> serif italic accent; ==word== -> gold highlight. HTML-escapes the rest. */
export function markup(s: string | undefined): string {
  if (!s) return "";
  const esc = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/==([^=]+)==/g, '<span class="hl">$1</span>')
    .replace(/\*([^*]+)\*/g, '<span class="ser">$1</span>');
}

const LOCKUP = `<div class="lockup"><span class="brand-mark">U</span><span class="wordmark">UseMoney<span class="ai">AI</span></span></div>`;
const SHORT_DISCLAIMER =
  "Education only · not investment advice · not a SEBI RIA";

function body(scene: Scene): string {
  switch (scene.type) {
    case "stat":
      return `${scene.stat?.kicker ? `<div class="kicker">${markup(scene.stat.kicker)}</div>` : ""}
        <div class="num-big">${markup(scene.stat?.value ?? scene.headline ?? "")}</div>
        ${scene.stat?.label ? `<div class="sub">${markup(scene.stat.label)}</div>` : ""}`;
    case "cards":
      return `<div class="h h-md">${markup(scene.headline)}</div>
        <div class="cards">${(scene.bullets ?? [])
          .map(
            (c, i, a) =>
              `<div class="card${i === a.length - 1 ? " gold" : ""}"><span class="n">${i + 1}</span> ${markup(c)}</div>`,
          )
          .join("")}</div>`;
    case "dataviz": {
      const max = Math.max(1, ...(scene.data ?? []).map((d) => d.value));
      return `<div class="h h-md">${markup(scene.headline)}</div>
        <div class="cards">${(scene.data ?? [])
          .map(
            (d) =>
              `<div class="card"><span class="n">${d.value}</span><div style="flex:1"><div style="height:.6em;border-radius:.3em;background:var(--emerald);width:${Math.round((d.value / max) * 100)}%"></div></div> ${markup(d.label)}</div>`,
          )
          .join("")}</div>`;
    }
    case "quote":
      return `<div class="h h-md ser">“${markup(scene.headline)}”</div>${scene.subtext ? `<div class="sub">— ${markup(scene.subtext)}</div>` : ""}`;
    case "cta":
      return `<div class="h h-md">${markup(scene.headline)}</div>${scene.subtext ? `<div class="sub">${markup(scene.subtext)}</div>` : ""}<div><span class="pill">→ usemoney.ai</span></div>`;
    case "hook":
      return `${scene.kicker ? `<div class="kicker">${markup(scene.kicker)}</div>` : ""}<div class="h">${markup(scene.headline)}</div>${scene.subtext ? `<div class="sub">${markup(scene.subtext)}</div>` : ""}`;
    default: // point, kinetic
      return `${scene.kicker ? `<div class="kicker">${markup(scene.kicker)}</div>` : ""}<div class="h h-md">${markup(scene.headline)}</div>${scene.subtext ? `<div class="sub">${markup(scene.subtext)}</div>` : ""}`;
  }
}

/** Returns full HTML, or null for media scenes (veo/screen/talkinghead) handled elsewhere. */
export function sceneHtml(
  scene: Scene,
  tl: Timeline,
  animate = false,
): string | null {
  if (
    scene.type === "veo" ||
    scene.type === "screen" ||
    scene.type === "talkinghead"
  )
    return null;
  const { w, h } = DIMENSIONS[tl.aspect];
  const rootPx = Math.min(w, h) / 100; // 10.8px → all sizes in rem are % of the short side
  const dark = tl.brandTheme === "dark";
  const showWM = tl.watermark && scene.type !== "cta";
  const sizing = `
    html{font-size:${rootPx}px}
    body{width:${w}px;height:${h}px;margin:0}
    .scene{padding:6rem 5.5rem 5rem}
    .top{font-size:1.3rem}.brand-mark{font-size:3rem}.wordmark{font-size:3rem}
    .kicker{font-size:1.6rem;margin-bottom:.4rem}
    .h{font-size:8.4rem}.h.h-md{font-size:5.6rem}
    .sub{font-size:2.7rem;max-width:92%}
    .num-big{font-size:15rem}
    .cards{font-size:2.7rem}.card .n{font-size:2.7rem}
    .fine{font-size:1.35rem}.pill{font-size:1.9rem}.watermark{font-size:1.35rem}`;
  return `<!DOCTYPE html><html><head><meta charset="utf8"><style>${fontCss()}${BRAND_CSS}${sizing}</style></head>
<body><div class="scene${dark ? " dark" : ""}${animate ? " anim-rise" : ""}">
  <div class="grain"></div>
  <div class="top">${LOCKUP}<div class="eyebrow"><span class="d"></span>USE MONEY. INTELLIGENTLY.</div></div>
  <div class="body">${body(scene)}</div>
  <div class="foot"><div class="fine">${scene.disclaimer ? SHORT_DISCLAIMER : ""}</div></div>
  ${showWM ? `<div class="watermark">usemoney.ai</div>` : ""}
</div></body></html>`;
}

/**
 * A full-frame, transparent caption layer (one line, bottom-centered). Rendered
 * as a PNG and overlaid onto the clip AFTER motion, so it stays static and legible
 * and works for any scene type (including Veo). Chromium shapes Devanagari (Hindi)
 * correctly via per-glyph fallback to a system Devanagari font.
 */
export function captionHtml(text: string, tl: Timeline): string {
  const { w, h } = DIMENSIONS[tl.aspect];
  const rootPx = Math.min(w, h) / 100;
  const dark = tl.brandTheme === "dark";
  const esc = (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const bg = dark ? "rgba(6,11,24,.82)" : "rgba(247,243,230,.88)";
  const fg = dark ? "#f1f5f9" : "#1d1d1b";
  return `<!DOCTYPE html><html><head><meta charset="utf8"><style>${fontCss()}
    html,body{margin:0;width:${w}px;height:${h}px;background:transparent;-webkit-font-smoothing:antialiased}
    .wrap{position:absolute;left:0;right:0;bottom:${Math.round(h * 0.085)}px;display:flex;justify-content:center}
    .cap{font-family:"Inter","Kohinoor Devanagari","Noto Sans Devanagari","Devanagari Sangam MN",sans-serif;
      font-weight:600;font-size:${(rootPx * 2.4).toFixed(1)}px;line-height:1.34;color:${fg};background:${bg};
      padding:.34em .7em;border-radius:.34em;max-width:84%;text-align:center;box-shadow:0 .2em .6em rgba(0,0,0,.12)}
  </style></head><body><div class="wrap"><span class="cap">${esc}</span></div></body></html>`;
}
