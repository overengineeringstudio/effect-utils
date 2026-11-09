#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
"${PYTHON_BIN:-python3}" "$root/scripts/editor-view-receipt.test.py"
exec "${PYTHON_BIN:-python3}" "$root/scripts/editor-view-supervisor.integration.test.py"
