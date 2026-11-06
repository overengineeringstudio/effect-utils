#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# Explicit maintainer action only. Normal genie/check never evaluates Nix or Cargo.
prerequisite() {
  printf >&2 'Offline refresh inputs unavailable. Provision them explicitly with:\nnix build --impure --no-link --file nix/stage0-cargo/refresh-inputs.nix\n'
  exit 1
}
nix build --offline --impure --dry-run --no-link --file nix/stage0-cargo/refresh-inputs.nix || prerequisite
inputs="$(nix build --offline --impure --no-link --print-out-paths --file nix/stage0-cargo/refresh-inputs.nix)" || prerequisite
export STAGE0_CARGO_REFRESH=1 STAGE0_CARGO="$inputs/cargo/bin/cargo"
export STAGE0_VENDOR="$inputs/vendor" RUSTC="$inputs/rustc/bin/rustc"
OTEL_SDK_DISABLED=true "$inputs/genie/bin/genie" \
  --cwd nix/stage0-cargo --output log
