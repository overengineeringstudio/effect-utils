#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
exec "${PYTHON_BIN:-python3}" "$root/scripts/editor-view-supervisor.integration.test.py"
