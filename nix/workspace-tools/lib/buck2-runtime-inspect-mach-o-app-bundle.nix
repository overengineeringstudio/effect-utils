# Inspect each bundle executable through the canonical Mach-O inspector.
{ pkgs, inspectionTools }:
let
  inspectExecutable = import ./buck2-runtime-inspect-mach-o-dynamic.nix {
    inherit pkgs inspectionTools;
  };
  script = pkgs.writeShellScript "buck2-runtime-inspect-mach-o-app-bundle" ''
    set -euo pipefail
    export LC_ALL=C
    fail() {
      echo "buck2-runtime-inspect-mach-o-app-bundle: FATAL - $*" >&2
      exit 1
    }
    [ "$#" -eq 2 ] || fail "usage: $0 DESCRIPTOR_JSON EXTRACTED_ROOT"
    descriptor="$1"
    root="$2"
    [ -f "$descriptor" ] || fail "descriptor does not exist"
    [ -d "$root" ] || fail "extracted root does not exist"
    [ "$(${pkgs.jq}/bin/jq -r '.runtime.kind' "$descriptor")" = mach-o-app-bundle ] \
      || fail "descriptor runtime kind must be mach-o-app-bundle"
    [ "$(${pkgs.jq}/bin/jq -r '.runtime.inspectionContract' "$descriptor")" = mach-o-app-bundle/v1 ] \
      || fail "unsupported inspection contract"
    bundle_root="$(${pkgs.jq}/bin/jq -r '.runtime.bundleRoot' "$descriptor")"
    plist="$root/$bundle_root/Contents/Info.plist"
    [ -f "$plist" ] && [ ! -L "$plist" ] || fail "bundle must contain a regular Contents/Info.plist"
    ${pkgs.gnugrep}/bin/grep -q '^<?xml' "$plist" || fail "bundle Info.plist is not an XML plist"
    temporary="$(${pkgs.coreutils}/bin/mktemp -d)"
    trap '${pkgs.coreutils}/bin/rm -rf "$temporary"' EXIT
    while IFS= read -r entry; do
      ${pkgs.jq}/bin/jq --argjson entry "$entry" '
        .entrypoints = [$entry.path] |
        .runtime = ($entry | del(.path)) + {
          kind: "mach-o-dynamic", inspectionContract: "mach-o-dynamic/v1",
          installNamePolicy: .runtime.installNamePolicy, rpathPolicy: .runtime.rpathPolicy
        }
      ' "$descriptor" > "$temporary/executable.json"
      ${inspectExecutable} "$temporary/executable.json" "$root"
    done < <(${pkgs.jq}/bin/jq -c '.runtime.executables[]' "$descriptor")
    declared="$(${pkgs.jq}/bin/jq -r '.entrypoints | sort | .[]' "$descriptor")"
    observed="$(${pkgs.jq}/bin/jq -r '.runtime.executables | map(.path) | sort | .[]' "$descriptor")"
    [ "$declared" = "$observed" ] || fail "entrypoints must be exactly the bundle executables"
  '';
in
script.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    inherit (inspectExecutable) inspectionToolIdentities;
  };
})
