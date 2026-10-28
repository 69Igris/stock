#!/bin/bash
# ============================================
# DEPRECATED - Use scripts/seed-env.sh instead
# ============================================
# This script is kept for backward compatibility.
# The canonical seed script is at the monorepo root:
#
#   ./scripts/seed-env.sh qa           # Seed QA database
#   ./scripts/seed-env.sh prod         # Seed Production database
#   ./scripts/seed-env.sh all          # Seed both
#   ./scripts/seed-env.sh prod --step 3  # Run only step 3
#
# See docs/reference/scripts-reference.md for full documentation.
# ============================================

set -e

echo ""
echo "WARNING: workers/scripts/seed.sh is deprecated."
echo ""
echo "Use the canonical seed script instead:"
echo "  ./scripts/seed-env.sh prod"
echo "  ./scripts/seed-env.sh qa"
echo "  ./scripts/seed-env.sh all"
echo ""
echo "See docs/reference/scripts-reference.md for details."
echo ""

# Forward to canonical script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec bash "$ROOT_DIR/scripts/seed-env.sh" "${@:-prod}"
