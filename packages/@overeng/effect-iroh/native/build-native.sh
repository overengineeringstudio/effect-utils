#!/usr/bin/env bash
set -euo pipefail

# Prototype recipe, not a Nix/Buck producer: official 1.1.0 bindings rebuilt
# against the committed lock's iroh 1.3.0. No forked Rust implementation.
package_root=$(dirname "$(dirname "$(realpath "$0")")")
source_sha=3103bf5295be6d50c5272ff7a426e9b539f3f587
archive_sha=a95eabacf896ebc2eed6780e90ff9da2c2be4cf8fad0427a3e5b69b98825e720
build_root="$package_root/native/.build"
mkdir -p "$build_root"
archive="$build_root/iroh-ffi.tar.gz"
if [[ ! -f "$archive" ]]; then
  curl --fail --location "https://github.com/n0-computer/iroh-ffi/archive/$source_sha.tar.gz" --output "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check
source_root="$build_root/iroh-ffi-$source_sha"
if [[ ! -d "$source_root" ]]; then
  tar -xzf "$archive" -C "$build_root"
fi
cp "$package_root/native/Cargo.lock" "$source_root/Cargo.lock"
uptime
# Bounded and low-priority even if the caller has a large build environment.
CARGO_TARGET_DIR="$build_root/target" nice -n19 cargo build --manifest-path "$source_root/Cargo.toml" --locked -p number0_iroh -j4
case "$(uname -s)" in
  Linux) library="$build_root/target/debug/libnumber0_iroh.so" ;;
  Darwin) library="$build_root/target/debug/libnumber0_iroh.dylib" ;;
  *) printf 'This prototype build recipe supports Linux/macOS only\n' >&2; exit 1 ;;
esac
cp "$library" "$build_root/iroh.node"
printf '\nPass nativeLibraryPath: \"%s\" to IrohEndpoint.make/layer (or set IROH_NATIVE_LIBRARY_PATH for the integration tests)\n' "$build_root/iroh.node"
