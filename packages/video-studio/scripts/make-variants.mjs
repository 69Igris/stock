#!/usr/bin/env node
/**
 * Generate 3 audio variants per reel from the base (Hindi) timelines.
 *
 *   hi     = as-authored — Hindi voiceover + music + Hindi captions
 *   en     = English voiceover (lang en-IN) + music + English captions
 *   silent = no voiceover, no music -> clean visual master (no caption band,
 *            English headline graphics only)
 *
 * The on-screen headlines/stats are already English in every base reel, so the
 * three sets share identical visuals + the same Veo B-roll (content-addressed
 * cache => English/silent re-renders never re-pay for Veo).
 *
 *   Usage:  node scripts/make-variants.mjs
 *   Output: timelines/variants/{hi,en,silent}/w1..w5.json
 *
 * SEBI: English VO below is education-only — no tips, calls, targets or prices.
 * Edit the EN map here (single source of truth), then re-run.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const TL = join(PKG, "timelines");
const REELS = ["w1", "w2", "w3", "w4", "w5"];
const SRC = (w) => `${w}-reel.json`;

// English voiceover, keyed by reel -> scene id. Mirrors the Hindi meaning.
const EN = {
  w1: {
    hook: "Quick question — do you really know what you actually own?",
    p1: "Owning thirty stocks doesn't always mean you're diversified.",
    p2: "The same company often hides across several funds you already hold.",
    broll: "Scattered investments should come together into one clear picture.",
    p3: "The first step is seeing your real exposure in one place.",
    cta: "Awareness first, decisions later — with UseMoney AI.",
  },
  w2: {
    hook: "The fees you can't see are often the ones that cost you the most.",
    cards:
      "Three fees people forget — exit load, regular-plan commission, and dormant account charges.",
    p1: "In a regular plan, commission quietly rides along every single year.",
    broll: "Small fees add up to a surprisingly big amount over the years.",
    p2: "Audit your fees in fifteen minutes and get to one clear number.",
    cta: "Costs are knowable — with UseMoney AI.",
  },
  w3: {
    hook: "Nine out of ten F and O traders end up losing money.",
    stat1: "In a SEBI study, ninety-three percent of traders made a net loss.",
    stat2:
      "That's about one point eight lakh crore rupees in net losses over three years.",
    broll: "Behind the speed and the thrill, there's often a very big risk.",
    p1: "Before the adrenaline, understand the odds and the risk.",
    cta: "Know the odds. This is not advice — only education.",
  },
  w4: {
    hook: "Over ten years — active funds versus the index. Who actually wins?",
    stat1: "In large-cap, seventy-three percent of active funds lagged the index.",
    stat2: "In mid and small-cap, eighty-two percent trailed their benchmark.",
    broll: "Over the long run, cost and consistency make the real difference.",
    p1: "Lower cost usually means fewer surprises.",
    cta: "Long game, low cost — with UseMoney AI.",
  },
  w5: {
    hook: "The first month of building UseMoney AI — a few honest numbers.",
    stat: "How many people joined in month one — the real number goes here.",
    cards:
      "What I learned — some added a second broker, a few subscribed, and I spent zero on tools.",
    broll: "A small start — but the direction is completely clear.",
    p1: "Transparency is the real product — build in public, learn in public.",
    cta: "Follow the build. UseMoney AI.",
  },
};

function write(rel, obj) {
  const p = join(TL, "variants", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  console.log("  wrote", p.slice(PKG.length + 1));
}

for (const w of REELS) {
  const base = JSON.parse(readFileSync(join(TL, SRC(w)), "utf8"));

  // 1) Hindi — as authored.
  write(join("hi", `${w}.json`), base);

  // 2) English — swap VO text + lang, keep everything else (music, captions).
  const en = structuredClone(base);
  en.title = `${base.title} (EN)`;
  for (const s of en.scenes) {
    if (!s.voiceover) continue;
    const t = EN[w]?.[s.id];
    if (!t) throw new Error(`missing EN text for ${w}/${s.id}`);
    s.voiceover.text = t;
    s.voiceover.lang = "en-IN";
  }
  write(join("en", `${w}.json`), en);

  // 3) Silent — drop music + every voiceover (=> no captions, clean visuals).
  const si = structuredClone(base);
  si.title = `${base.title} (Silent)`;
  delete si.music;
  for (const s of si.scenes) delete s.voiceover;
  write(join("silent", `${w}.json`), si);
}

console.log("\nDone. 3 sets x 5 reels -> timelines/variants/{hi,en,silent}/");
