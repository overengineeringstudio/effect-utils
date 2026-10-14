# Source-mode JavaScript product import; constructed only by from-source.nix
# through javascript-product-import.nix. The descriptor and revision provenance
# are validated in this build against static consumer facts, never read at
# evaluation, so evaluating a consumer never needs the producer output.
{ pkgs }:

{
  sourceImport,
  artifact,
  descriptor,
  expectedExternalCapabilities ? [ ],
  expectedExternalModules ? [ ],
  expectedProductKind,
  expectedProductName,
  binaryName ? null,
  environment ? { },
  generateCompletions ? binaryName != null,
  nativeNodePackages ? [ ],
  pathPackages ? [ ],
  smokeTestArgs ? null,
}:

# No independent descriptor pin: trust comes from the producer build identity
# (sourceDigest/producerCommit). Static per-field facts and integrity/size
# checks against payload bytes catch transit tampering. The runtime-closure
# digest is only a self-consistency check.
let
  lib = pkgs.lib;
  facts = sourceImport.facts;
  runtime = if facts.expectedRuntimeKind == "bun" then pkgs.bun else pkgs.nodejs_24 or pkgs.nodejs;
  factsFile = pkgs.writeText "javascript-source-import-facts.json" (
    builtins.toJSON (
      facts
      // {
        inherit
          expectedProductKind
          expectedProductName
          expectedExternalCapabilities
          expectedExternalModules
          ;
      }
    )
  );
in
pkgs.runCommand "${expectedProductName}-buck2-candidate"
  {
    nativeBuildInputs = [
      pkgs.makeWrapper
      pkgs.jq
      pkgs.coreutils
      pkgs.openssl
    ];
    passthru.buck2Product = sourceImport.product;
    meta = lib.optionalAttrs (binaryName != null) { mainProgram = binaryName; };
  }
  ''
    set -euo pipefail
    source_product=${lib.escapeShellArg (toString sourceImport.product)}
    artifact=${lib.escapeShellArg (toString artifact)}
    descriptor=${lib.escapeShellArg (toString descriptor)}
    facts=${factsFile}
    ${builtins.readFile ./javascript-source-import-validate.sh}
    module_path=${lib.escapeShellArg facts.expectedModulePath}
    mkdir -p "$out/libexec/$(dirname "$module_path")"
    cp "$artifact" "$out/libexec/$module_path"
    chmod 0444 "$out/libexec/$module_path"
    ${lib.optionalString sourceImport.hasRuntimeClosure ''
      closure="$source_product/runtime-closure"
      digest="$(jq -er '.digest | select(test("^[0-9a-f]{64}$"))' "$closure/descriptor.json")" || fail runtime-closure-digest
      ${pkgs.nodejs_24 or pkgs.nodejs}/bin/node ${../../../buck2/dependencies/runtime-closure.ts} \
        --verify "$closure" --expected-digest "$digest" || fail runtime-closure
      cp -R "$closure"/. "$out/libexec/"
      chmod u+w "$out/libexec/node_modules"
    ''}
    ${lib.concatMapStringsSep "\n" (package: ''
      mkdir -p "$out/libexec/node_modules/$(dirname ${lib.escapeShellArg package.name})"
      ln -s ${package.package} "$out/libexec/node_modules/${package.name}"
    '') nativeNodePackages}
    ${lib.optionalString (binaryName != null) ''
      mkdir -p "$out/bin"
      makeWrapper ${runtime}/bin/${facts.expectedRuntimeKind} "$out/bin/${binaryName}" \
        --add-flags "${
          lib.optionalString (facts.expectedRuntimeKind == "bun") "--no-install "
        }$out/libexec/$module_path" \
        ${
          lib.concatStringsSep " " (
            lib.mapAttrsToList (
              name: entry: "--set ${lib.escapeShellArg name} ${lib.escapeShellArg entry}"
            ) environment
          )
        } \
        ${lib.optionalString (
          pathPackages != [ ]
        ) "--prefix PATH : ${lib.escapeShellArg (lib.makeBinPath pathPackages)}"}
    ''}
    ${lib.optionalString (generateCompletions && binaryName != null) ''
      mkdir -p "$out/share/fish/vendor_completions.d" "$out/share/bash-completion/completions" "$out/share/zsh/site-functions"
      generate_completion() {
        if "$out/bin/${binaryName}" --log-level none --completions "$1" > "$2" 2>/dev/null; then return; fi
        if "$out/bin/${binaryName}" --completions "$1" > "$2" 2>/dev/null; then return; fi
        rm -f "$2"
      }
      generate_completion fish "$out/share/fish/vendor_completions.d/${binaryName}.fish"
      generate_completion bash "$out/share/bash-completion/completions/${binaryName}"
      generate_completion zsh "$out/share/zsh/site-functions/_${binaryName}"
    ''}
    ${lib.optionalString (smokeTestArgs != null && binaryName != null) ''
      "$out/bin/${binaryName}" ${lib.escapeShellArgs smokeTestArgs} >/dev/null
    ''}
  ''
