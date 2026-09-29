#!/usr/bin/env bash
set -euo pipefail

node --test scripts/lint-no-tailwind.unit.test.mjs
node scripts/lint-no-tailwind.mjs
