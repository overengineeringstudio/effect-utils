# Realize one buck-build-product/v1 artifact into the Nix store.
#
# This is the single validation path shared by published imports (descriptor
# known at evaluation, payload fetched by digest) and source imports (descriptor
# and payload produced by a Buck build derivation). Every realization re-runs the
# descriptor contract at build time from `buck2-build-product-contract.nix`, so
# a descriptor that only exists inside the build is held to the same exact
# schema, digest, and platform/runtime rules without import-from-derivation.
# Evaluation-time facts (name, platform, runtime kind, and, for published
# products, the descriptor digest) are the caller's declaration; the build
# fails unless the observed descriptor matches them.
{
  pkgs,
  inspectElfDynamic ? import ./buck2-runtime-inspect-elf-dynamic.nix { inherit pkgs; },
  inspectElfStatic ? import ./buck2-runtime-inspect-elf-static.nix { inherit pkgs; },
  inspectMachODynamic ?
    if pkgs.stdenv.hostPlatform.isDarwin then
      import ./buck2-runtime-inspect-mach-o-dynamic.nix {
        inherit pkgs;
        inspectionTools = import ./buck2-darwin-inspection-tools.nix { inherit pkgs; };
      }
    else
      null,
}:

let
  lib = pkgs.lib;
  scan = import ./buck2-artifact-scan.nix { inherit pkgs; };
  contractFile = ./buck2-build-product-contract.nix;
  runtimeKinds = [
    "elf-dynamic"
    "elf-static"
    "mach-o-dynamic"
  ];
  # The contract is pure Nix; a store-less, read-only evaluator applies it to a
  # descriptor that only exists inside this build.
  observeDescriptor = pkgs.writeShellScript "buck2-artifact-observe-descriptor" ''
    set -euo pipefail
    [ "$#" -eq 2 ] || { echo "usage: $0 DESCRIPTOR_JSON OBSERVATION_JSON" >&2; exit 64; }
    state="$(${pkgs.coreutils}/bin/mktemp -d)"
    trap '${pkgs.coreutils}/bin/rm -rf "$state"' EXIT
    NIX_STATE_DIR="$state/state" NIX_LOG_DIR="$state/log" HOME="$state" \
      ${pkgs.nix}/bin/nix-instantiate --eval --strict --json --readonly-mode \
        --store dummy:// --option experimental-features "" \
        --argstr contractFile ${contractFile} \
        --argstr descriptorFile "$(${pkgs.coreutils}/bin/realpath "$1")" \
        --expr '
          { contractFile, descriptorFile }:
          let
            contract = import contractFile;
            descriptor = builtins.fromJSON (builtins.readFile descriptorFile);
            checked = contract.validateDescriptor descriptor;
          in
          {
            canonical = contract.canonicalDescriptorJson descriptor;
            digest = contract.descriptorDigest descriptor;
            name = checked.name;
            platform = checked.platform;
            runtimeKind = checked.runtime.kind;
            target = checked.semanticProvenance.target;
          }
        ' > "$2"
  '';
in
{
  name,
  runtimeKind,
  expectedPlatform,
  # Shell expressions that expand to paths at build time.
  descriptorPath,
  archivePath,
  expectedDescriptorDigest ? null,
  expectedTarget ? null,
  passthru ? { },
}:

let
  dynamicElfRuntimeInputs = lib.optionals (runtimeKind == "elf-dynamic") [
    pkgs.glibc
    pkgs.libgcc
  ];
  inspector =
    if runtimeKind == "elf-dynamic" then
      inspectElfDynamic
    else if runtimeKind == "elf-static" then
      inspectElfStatic
    else
      inspectMachODynamic;
  declared = builtins.toJSON {
    inherit name runtimeKind;
    platform = expectedPlatform;
    digest = expectedDescriptorDigest;
    target = expectedTarget;
  };
in
assert lib.assertMsg (builtins.elem runtimeKind runtimeKinds)
  "buck2-artifact-realize: runtime inspector is not available for ${toString runtimeKind}";
assert lib.assertMsg (
  runtimeKind != "mach-o-dynamic" || inspectMachODynamic != null
) "buck2-artifact-realize: mach-o-dynamic inspection requires a Darwin Nix tool realization";
assert lib.assertMsg (builtins.isAttrs expectedPlatform)
  "buck2-artifact-realize: expectedPlatform must be an exact platform attribute set";
assert lib.assertMsg (
  runtimeKind != "elf-dynamic"
  || (
    pkgs.stdenv.hostPlatform.system == "${expectedPlatform.architecture}-${expectedPlatform.os}"
    && pkgs.stdenv.hostPlatform.libc == expectedPlatform.abi
  )
) "buck2-artifact-realize: elf-dynamic platform must match pkgs.stdenv.hostPlatform";
pkgs.runCommand "${name}-buck2-import"
  {
    nativeBuildInputs = [
      pkgs.openssl
    ]
    ++ lib.optional (runtimeKind == "elf-dynamic") pkgs.autoPatchelfHook;
    buildInputs = dynamicElfRuntimeInputs;
    allowedReferences = lib.optionals (runtimeKind == "elf-dynamic") (
      [ "out" ] ++ dynamicElfRuntimeInputs
    );
    inherit passthru;
  }
  ''
    set -euo pipefail
    fail() {
      echo "buck2-artifact-realize: $*" >&2
      exit 1
    }
    descriptor_input=${descriptorPath}
    archive=${archivePath}
    observation="$TMPDIR/descriptor-observation.json"
    ${observeDescriptor} "$descriptor_input" "$observation"
    declared=${lib.escapeShellArg declared}
    ${pkgs.jq}/bin/jq -e --argjson declared "$declared" '
      .name == $declared.name
      and .platform == $declared.platform
      and .runtimeKind == $declared.runtimeKind
      and ($declared.digest == null or .digest == $declared.digest)
      and (
        $declared.target == null
        or .target == $declared.target
        # A cell-relative declaration matches the cell-qualified label
        # `str(ctx.label.raw_target())` records, whatever the root names the cell.
        or ($declared.target | startswith("//")) and (.target | sub("^[A-Za-z0-9_-]+//"; "//")) == $declared.target
      )
    ' "$observation" >/dev/null || {
      ${pkgs.jq}/bin/jq -n --argjson declared "$declared" --slurpfile observed "$observation" \
        '{declared: $declared, observed: ($observed[0] | del(.canonical))}' >&2
      fail "descriptor does not match the declared product"
    }
    descriptor="$TMPDIR/descriptor.json"
    ${pkgs.jq}/bin/jq -j .canonical "$observation" > "$descriptor"

    expected_size="$(${pkgs.jq}/bin/jq -r .payload.sizeBytes "$descriptor")"
    actual_size="$(${pkgs.coreutils}/bin/stat --format=%s "$archive")"
    [ "$actual_size" = "$expected_size" ] \
      || fail "payload size mismatch: expected $expected_size, got $actual_size"
    expected_digest="$(${pkgs.jq}/bin/jq -r .payload.digest.sri "$descriptor")"
    actual_digest="sha256-$(${pkgs.openssl}/bin/openssl dgst -sha256 -binary "$archive" \
      | ${pkgs.openssl}/bin/openssl base64 -A)"
    [ "$actual_digest" = "$expected_digest" ] || fail "payload digest mismatch"

    ${scan} archive "$archive"
    mkdir -p "$out"
    ${pkgs.gnutar}/bin/tar --extract --file "$archive" --directory "$out" \
      --no-same-owner --no-same-permissions
    ${scan} tree "$out"
    ${inspector} "$descriptor" "$out"
    ${lib.optionalString (runtimeKind == "elf-dynamic") ''
      ${pkgs.findutils}/bin/find "$out" -type f -exec chmod u+w {} +
      autoPatchelf "$out"
      while IFS= read -r entrypoint; do
        if ! load_error="$(${pkgs.stdenv.cc.bintools.dynamicLinker} --list "$out/$entrypoint" 2>&1 >/dev/null)" \
          || [ -n "$load_error" ]; then
          printf '%s\n' "$load_error" >&2
          fail "dynamic ELF runtime is incompatible: $entrypoint"
        fi
      done < <(${pkgs.jq}/bin/jq -r '.entrypoints[]' "$descriptor")
    ''}

    ${pkgs.findutils}/bin/find "$out" -type d -exec chmod 0555 {} +
    while IFS= read -r -d "" file; do
      if [ -x "$file" ]; then chmod 0555 "$file"; else chmod 0444 "$file"; fi
    done < <(${pkgs.findutils}/bin/find "$out" -type f -print0)
  ''
