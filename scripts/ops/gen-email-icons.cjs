/**
 * MONEY-878 follow-up: generate the email footer icon PNGs (social + the
 * "was this email useful?" thumbs) from the brand glyphs used on the site
 * (apps/web/components/marketing/PlayfulFooter.tsx). Cream-toned for the
 * pinned-dark footer band, 48px (2x for a ~24px display), transparent bg.
 *
 * Output: apps/web/public/email/social/*.png  → served at
 * https://usemoney.ai/email/social/<name>.png (same static path as the logo).
 *
 * Re-run after a glyph/color change:  node scripts/ops/gen-email-icons.cjs
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "../../apps/web/public/email/social");
fs.mkdirSync(OUT, { recursive: true });

const C = "#3a3a35"; // ink that reads on the light footer band
const SIZE = 48;

const fillIcon = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><path fill="${C}" d="${d}"/></svg>`;

const strokeIcon = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${C}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const icons = {
  x: fillIcon(
    "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  ),
  linkedin: fillIcon(
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452z",
  ),
  youtube: fillIcon(
    "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  ),
  instagram: strokeIcon(
    '<rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>',
  ),
  "useful-yes": strokeIcon(
    '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  ),
  "useful-no": strokeIcon(
    '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
  ),
};

// ── Brand logo (rounded-square "U") — light + dark variants ────────────────
// Recolored from apps/web/public/icon-square.svg so the mark reads on BOTH the
// cream header (ink square) AND the pinned-dark footer band / iOS dark mode
// (cream square). 88px ≈ 2x the ~44px display box.
const LOGO_OUT = path.join(__dirname, "../../apps/web/public/email");
fs.mkdirSync(LOGO_OUT, { recursive: true });

const LOGO_SIZE = 88;
const logoSvg = (square, u) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${LOGO_SIZE}" height="${LOGO_SIZE}">` +
  `<g transform="rotate(-3 256 256)">` +
  `<rect width="512" height="512" rx="92" ry="92" fill="${square}"/>` +
  `<text x="256" y="372" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, monospace" font-weight="800" font-size="340" fill="${u}" letter-spacing="-8">U</text>` +
  `</g></svg>`;

const logos = {
  "logo-light": logoSvg("#1d1d1b", "#f7f3e6"), // ink square + cream U → light bg
  "logo-dark": logoSvg("#f4ede0", "#1d1d1b"), // cream square + ink U → dark bg
};

// ── "Ask AI" assistant marks (footer AI row) ───────────────────────────────
// Brand-colored, 48px (2x a ~20px display box), transparent bg. SVG sources
// lifted verbatim from apps/web/components/marketing/PlayfulFooter.tsx
// (ASK_AI_TARGETS). Used by the redesigned email footer's "Ask AI about
// UseMoney AI" row (packages/email). The email renders these on LIGHT rounded
// cells in BOTH modes because the dark marks (ChatGPT / Grok ink) are baked
// into the PNG and can't be recolored per dark-mode like the site's
// currentColor glyphs. claude has no vector mark → resized from the committed
// raster /ai-logos/claude.png.
const AI_OUT = path.join(__dirname, "../../apps/web/public/email/ai");
fs.mkdirSync(AI_OUT, { recursive: true });

const CLAUDE_SRC = path.join(
  __dirname,
  "../../apps/web/public/ai-logos/claude.png",
);

const aiIcons = {
  // OpenAI ChatGPT — monochrome 6-loop knot (brand ink).
  chatgpt:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">` +
    `<path fill="#1d1d1b" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .039.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`,
  // Perplexity — icon-only compass-star (brand teal stroke, no fill).
  perplexity:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 28 36" fill="none" stroke="#20808D" stroke-width="1.5" stroke-miterlimit="10">` +
    `<path d="m23.566,1.398l-9.495,9.504h9.495V1.398v2.602V1.398Zm-9.496,9.504L4.574,1.398v9.504h9.496Zm-.021-10.902v36m9.517-15.596l-9.495-9.504v13.625l9.495,9.504v-13.625Zm-18.991,0l9.496-9.504v13.625l-9.496,9.504v-13.625ZM.5,10.9v13.57h4.074v-4.066l9.496-9.504H.5Zm13.57,0l9.495,9.504v4.066h4.075v-13.57h-13.57Z"/></svg>`,
  // Google Gemini — 4-point sparkle (Google blue).
  gemini:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">` +
    `<path fill="#4285F4" d="M12 2 C12 7.5 16.5 12 22 12 C16.5 12 12 16.5 12 22 C12 16.5 7.5 12 2 12 C7.5 12 12 7.5 12 2 Z"/></svg>`,
  // Grok (xAI) — 2-path angular swoosh (brand ink).
  grok:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 34 33">` +
    `<path fill="#1d1d1b" d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436"/>` +
    `<path fill="#1d1d1b" d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341"/></svg>`,
};

(async () => {
  for (const [name, svg] of Object.entries(icons)) {
    const out = path.join(OUT, `${name}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log("wrote", out);
  }
  for (const [name, svg] of Object.entries(logos)) {
    const out = path.join(LOGO_OUT, `${name}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log("wrote", out);
  }
  for (const [name, svg] of Object.entries(aiIcons)) {
    const out = path.join(AI_OUT, `${name}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log("wrote", out);
  }
  // claude — no vector mark; resize the committed raster onto a transparent box.
  const claudeOut = path.join(AI_OUT, "claude.png");
  await sharp(CLAUDE_SRC)
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(claudeOut);
  console.log("wrote", claudeOut);
})();
