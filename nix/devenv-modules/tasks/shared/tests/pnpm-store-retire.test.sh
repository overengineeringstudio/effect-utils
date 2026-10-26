#!/usr/bin/env bash
set -euo pipefail
# The Python suite creates and removes only its own temporary store fixtures.
exec "${PYTHON_BIN:-python3}" "$(dirname "$0")/pnpm-store-retire.test.py"
