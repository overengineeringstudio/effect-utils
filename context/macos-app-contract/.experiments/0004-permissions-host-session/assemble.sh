#!/bin/bash
# Builder-only, unsigned assembly. Never launches, installs or signs any app.
# Usage: bash assemble.sh NATIVE_APP RELEASE SIGNER_JSON OUT_LINK
# SIGNER_JSON contains public identity policy {"teamId":"…","identity":"…"} only.
set -euo pipefail
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
native_bundle="${1:?native app required}"
release="${2:?release required}"
signer="${3:?signer policy JSON file required}"
out="${4:?output link required}"
case "$release" in 1|2) ;; *) echo 'release must be 1 or 2' >&2; exit 64 ;; esac
# Import before evaluation: the Nix build user cannot traverse a user's home.
# A Nix path string alone does not import the native app into the store.
imported="$(nice -n 19 nix store add --mode nar "$native_bundle")"
case "$imported" in /nix/store/*.app) ;; *) echo 'expected imported app store path' >&2; exit 64 ;; esac
if pgrep -f '[R]unner.Worker'; then
  echo 'unsigned assembly refused: CI worker active' >&2
  exit 75
fi
exec nice -n 19 nix build --impure --option builders '' --option max-jobs 2 \
  --file "$here/assemble.nix" --argstr nativeBundle "$imported" \
  --argstr release "$release" --argstr signerFile "$signer" --out-link "$out"
