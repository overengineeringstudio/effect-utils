#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?repository root required}"
archive_tool="${2:?archive-tool package path required}"
bun="${3:?bun executable path required}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A different valid realization may occupy the same input-addressed store path.
# Model the former bytes without mutating the store, then project the current
# bytes using the same CLI that runs inside both from-source derivations.
printf '%s\n' "$archive_tool" > "$tmp/closure"
"$bun" -e 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify([{capability:{toolId:"archive-tool",protocol:"effect-utils/buck2-archive-tool/v2",flakePackage:"buck2-archive-tool",executable:"bin/buck2-archive-tool"},nixOutputPath:process.argv[2],closurePathsFile:process.argv[3]}]))' "$tmp/input.json" "$archive_tool" "$tmp/closure"
case "$(uname -s)" in
  Linux) platform="$(uname -m)-linux" ;;
  Darwin) platform="$(uname -m)-macos" ;;
  *) echo 'unsupported capability test platform' >&2; exit 1 ;;
esac
"$bun" "$repo_root/packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts" \
  --input "$tmp/input.json" --output "$tmp/current" --platform "$platform"
manifest="$(find "$tmp/current/generations" -name manifest.json -print -quit)"
old_digest="$( { cat "$archive_tool/bin/buck2-archive-tool"; printf 'different realization'; } | sha256sum | cut -d' ' -f1)"
jq --arg digest "$old_digest" '.contentDigest = $digest' "$manifest" > "$tmp/stale.json"
if "$archive_tool/bin/buck2-archive-tool" --capability-manifest "$tmp/stale.json" extract-crate --archive "$tmp/missing.crate" --out "$tmp/out" --strip-prefix missing >"$tmp/stale.log" 2>&1; then
  echo 'stale realization unexpectedly accepted' >&2
  exit 1
fi
grep -q 'BUCK2_CAPABILITY_DIGEST' "$tmp/stale.log"
if "$archive_tool/bin/buck2-archive-tool" --capability-manifest "$manifest" extract-crate --archive "$tmp/missing.crate" --out "$tmp/out" --strip-prefix missing >"$tmp/current.log" 2>&1; then
  echo 'missing archive unexpectedly accepted' >&2
  exit 1
fi
grep -q 'BUCK2_ARCHIVE_INPUT' "$tmp/current.log"
grep -q "$(sha256sum "$archive_tool/bin/buck2-archive-tool" | cut -d' ' -f1)" "$tmp/current/defs.bzl"
printf 'stale bytes rejected; consumer projection accepts current executable and reaches archive action\n'
