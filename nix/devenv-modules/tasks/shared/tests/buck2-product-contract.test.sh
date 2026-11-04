#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd -P)"
exec "${BASH_BIN:-$BASH}" "$repo/nix/workspace-tools/lib/tests/buck2-build-product-contract.sh" "$repo"
