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
]'
gate-slot --class eval --max-wait 5400 --max-hold 600 -- nice -n 19 \
  nix build --impure --dry-run --no-link --expr "$expression"
inputs="$(gate-slot --lane build --max-wait 5400 --max-hold 900 -- nice -n 19 \
  nix build --impure --no-link --print-out-paths --expr "$expression")"
export STAGE0_CARGO_REFRESH=1 STAGE0_CARGO="$inputs/cargo/bin/cargo"
export STAGE0_VENDOR="$inputs/vendor" RUSTC="$inputs/rustc/bin/rustc"
OTEL_SDK_DISABLED=true /nix/store/015rck220f45nwg9v2xlxi1q71x8d86c-genie-buck2-candidate/bin/genie \
  --cwd nix/stage0-cargo --output log
