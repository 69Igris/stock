#!/usr/bin/env bash
# Launcher for the video-studio MCP server (Claude Desktop / Cowork).
# Loads packages/video-studio/.env so secrets stay out of the Claude config,
# and uses NODE_BIN / FFMPEG_PATH from .env (GUI apps don't inherit your shell PATH).
set -euo pipefail
cd "$(dirname "$0")"
set -a
[ -f .env ] && . ./.env
set +a
exec "${NODE_BIN:-node}" --import tsx src/index.ts
