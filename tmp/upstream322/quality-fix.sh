#!/usr/bin/env bash
set -euo pipefail
test "$(df -B1 --output=avail /home | tail -1)" -ge 120000000000
devenv tasks run lint:fix --no-tui --show-output
