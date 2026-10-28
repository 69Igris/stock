#!/bin/sh
# Sync TradingView Advanced Charts from the vendor submodule to apps/web/public/.
#
# IMPORTANT: this script no longer auto-runs on postinstall. The committed copies
# in apps/web/public/charting_library/ are the source of truth for deploys
# (Vercel cannot init the private submodule). Auto-syncing on every install
# caused 957 bundle files to constantly drift in `git status` between v30 and
# v31 of the library - the recurring "regression" the team kept seeing.
#
# When you intentionally upgrade the library:
#   1. Bump the submodule:  git -C vendor/charting_library checkout <new-tag>
#   2. Run:                 yarn sync:chart
#   3. Review + commit the resulting public/ diff in a dedicated PR.
#
# MONEY-1383: step 2 also regenerates apps/web/lib/charts/preload-manifest.json
# (the `<link rel=preload>` hrefs the stock / ETF / paper-trading pages render).
# `bundles/library.<contenthash>.js` gets a new hash on every upgrade and a
# stale preload href 404s SILENTLY, so the manifest is generated from the
# loader rather than hand-maintained — and
# apps/web/__tests__/charts/chart-preload-manifest.test.ts fails the build if
# it drifts.
#
# Source: vendor/charting_library (git submodule → github.com/tradingview/charting_library)
# Target: apps/web/public/charting_library + apps/web/public/datafeeds

set -eu

# Hard-stop unless explicitly invoked. The package.json `postinstall` only sets
# SYNC_CHARTING_LIBRARY=1 via the `yarn sync:chart` script; bare `yarn install`
# does NOT, so the script becomes a no-op for normal developer flow.
if [ "${SYNC_CHARTING_LIBRARY:-0}" != "1" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SRC="$REPO_ROOT/vendor/charting_library"
DST="$REPO_ROOT/apps/web/public"

# Skip gracefully if submodule not initialized (workers build, CI without submodules)
if [ ! -d "$SRC/charting_library" ]; then
  echo "[sync-charting-library] Submodule not initialized - skipping (run: git submodule update --init)"
  exit 0
fi

# Skip if target already exists and is up-to-date (avoid slow copy on every install)
# Compare both version string AND a content checksum of a representative bundle file
# to prevent re-copying files that only differ in formatting (pretty vs minified).
if [ -f "$DST/datafeeds/udf/dist/bundle.js" ] && [ -f "$DST/charting_library/package.json" ]; then
  SRC_VERSION=$(grep -o '"description".*' "$SRC/charting_library/package.json" 2>/dev/null | head -1)
  DST_VERSION=$(grep -o '"description".*' "$DST/charting_library/package.json" 2>/dev/null | head -1)
  if [ "$SRC_VERSION" = "$DST_VERSION" ]; then
    # Version matches - also check content hash of a bundle to catch formatting diffs
    SRC_HASH=$(md5 -q "$SRC/charting_library/charting_library.standalone.js" 2>/dev/null || md5sum "$SRC/charting_library/charting_library.standalone.js" 2>/dev/null | cut -d' ' -f1)
    DST_HASH=$(md5 -q "$DST/charting_library/charting_library.standalone.js" 2>/dev/null || md5sum "$DST/charting_library/charting_library.standalone.js" 2>/dev/null | cut -d' ' -f1)
    if [ "$SRC_HASH" = "$DST_HASH" ]; then
      echo "[sync-charting-library] Already up-to-date (version + content match) - skipping copy"
      exit 0
    fi
    echo "[sync-charting-library] Version matches but content differs - re-syncing"
  fi
fi

echo "[sync-charting-library] Syncing from vendor/charting_library → apps/web/public/"

# Clean previous copies
rm -rf "$DST/charting_library" "$DST/datafeeds"

# Copy charting_library (the widget itself)
cp -r "$SRC/charting_library" "$DST/charting_library"

# Copy datafeeds (UDF adapter)
cp -r "$SRC/datafeeds" "$DST/datafeeds"

# MONEY-1383 (L2): re-derive the chart preload manifest from the loader that
# was just copied in. Cheap (one regex over a 58 KB file) and it is the only
# thing keeping the hashed-bundle hrefs honest across an upgrade.
echo "[sync-charting-library] Regenerating the chart preload manifest"
( cd "$REPO_ROOT" && npx tsx scripts/gen-chart-preload-manifest.ts )

echo "[sync-charting-library] Done."
