#!/usr/bin/env bash
# Render the 3 audio sets (no-audio / hindi / english) for the week reels.
#
#   ./scripts/render-sets.sh                 # all weeks, all 3 sets
#   ./scripts/render-sets.sh w3 w5           # only those weeks
#   SETS="en" ./scripts/render-sets.sh       # only the English set (all weeks)
#   SETS="en" ./scripts/render-sets.sh w5    # English, w5 only (after filling numbers)
#
# Prereqs:
#   - run `node scripts/make-variants.mjs` first (writes timelines/variants/*)
#   - .env has GCP creds + VIDEO_STUDIO_OUT (Veo is a cache-hit; TTS needed for hi/en)
#   - ffmpeg + Playwright chromium installed
#
# Output: $VIDEO_STUDIO_OUT/{no-audio,hindi,english}/w1..w5.mp4
set -euo pipefail
cd "$(dirname "$0")/.."                       # -> packages/video-studio
set -a; [ -f .env ] && . ./.env; set +a
: "${VIDEO_STUDIO_OUT:?Set VIDEO_STUDIO_OUT in .env (an output folder OUTSIDE the repo)}"

WEEKS=("$@"); [ ${#WEEKS[@]} -eq 0 ] && WEEKS=(w1 w2 w3 w4 w5)
SETS=${SETS:-"silent hi en"}
declare -A DIR=( [silent]=no-audio [hi]=hindi [en]=english )

for s in $SETS; do mkdir -p "$VIDEO_STUDIO_OUT/${DIR[$s]}"; done

for w in "${WEEKS[@]}"; do
  for s in $SETS; do
    tl="timelines/variants/$s/$w.json"
    [ -f "$tl" ] || { echo "skip (missing): $tl"; continue; }
    out="${DIR[$s]}/$w.mp4"
    echo "▶ ${s} ${w} -> ${VIDEO_STUDIO_OUT}/${out}"
    node --import tsx src/cli.ts "$tl" "$out"
  done
done
echo "✓ done -> ${VIDEO_STUDIO_OUT}/{no-audio,hindi,english}/"
