#!/usr/bin/env bash
set -euo pipefail

# Both destinations execute OverengKitTests and the exact same bundled goldens.
package_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-macos}" in
  macos)
    exec swift test --package-path "$package_dir"
    ;;
  ios)
    if [[ $# -ne 2 || "$2" != platform=iOS\ Simulator,* ]]; then
      printf '%s\n' 'Usage: bash test.sh ios "platform=iOS Simulator,id=<device-UDID>"' >&2
      exit 2
    fi
    cd -- "$package_dir"
    exec xcodebuild -scheme OverengKit-Package -destination "$2" test
    ;;
  *)
    printf '%s\n' 'Usage: bash test.sh macos | ios "platform=iOS Simulator,id=<device-UDID>"' >&2
    exit 2
    ;;
esac
