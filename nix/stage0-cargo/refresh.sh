#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# Explicit maintainer action only. Normal genie/check never evaluates Nix or Cargo.
expression='let
  f = builtins.getFlake ("git+file://" + toString ./.);
  p = import f.inputs.nixpkgs { system = "x86_64-linux"; };
  vendor = p.rustPlatform.importCargoLock { lockFile = ./rust/Cargo.lock; };
in p.linkFarm "stage0-cargo-refresh-inputs" [
  { name = "cargo"; path = p.cargo; }
  { name = "rustc"; path = p.rustc; }
  { name = "vendor"; path = vendor; }
  { name = "genie"; path = f.packages.x86_64-linux.genie; }
]'
prerequisite() {
  printf >&2 'Offline refresh inputs unavailable. Provision them explicitly with:\nnix build --impure --no-link --expr %q\n' "$expression"
  exit 1
}
gate-slot --class eval --max-wait 5400 --max-hold 600 -- nice -n 19 \
  nix build --offline --impure --dry-run --no-link --expr "$expression" || prerequisite
inputs="$(gate-slot --lane build --max-wait 5400 --max-hold 900 -- nice -n 19 \
  nix build --offline --impure --no-link --print-out-paths --expr "$expression")" || prerequisite
export STAGE0_CARGO_REFRESH=1 STAGE0_CARGO="$inputs/cargo/bin/cargo"
export STAGE0_VENDOR="$inputs/vendor" RUSTC="$inputs/rustc/bin/rustc"
OTEL_SDK_DISABLED=true "$inputs/genie/bin/genie" \
  --cwd nix/stage0-cargo --output log
