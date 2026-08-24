#!/usr/bin/env bash
set -euo pipefail

workspace_root="${1:?workspace root is required}"
crate_path="${2:?crate path is required}"

workspace_root="$(cd "$workspace_root" && pwd -P)"
crate_root="$(cd "$workspace_root/$crate_path" && pwd -P)"
case "$crate_root/" in
  "$workspace_root"/*) ;;
  *)
    echo "cargo crate path escapes the workspace: $crate_path" >&2
    exit 1
    ;;
esac

cd "$crate_root"
cargo build --release
cargo test
cargo clippy -- -D warnings
cargo fmt --check
