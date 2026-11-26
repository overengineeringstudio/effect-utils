#!/usr/bin/env bash
# Regenerates the committed wasm-bindgen assets in ../wasm; do not edit those assets.
set -euo pipefail
cd "$(dirname "$0")"
# Cargo.toml and the CLI must agree on the wasm-bindgen schema version.
test "$(wasm-bindgen --version)" = 'wasm-bindgen 0.2.130'
cargo build --locked --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir ../wasm \
  target/wasm32-unknown-unknown/release/games_iroh_wasm.wasm
