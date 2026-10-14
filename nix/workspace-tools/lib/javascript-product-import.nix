# Import one Buck-produced JavaScript product into the Nix store.
#
# Published mode checks what makes the product usable: the descriptor schema,
# the semantic product/runtime contract, the portable platform it claims, the
# capabilities this consumer must supply, and the exact bytes. What is NOT
# checked is who produced it — the producer's Nix store paths and configured
# Buck target are recorded as `provenance` in the descriptor and are host
# facts, so gating on them would reject a byte-identical product built
# anywhere else. `provenance` is therefore deliberately read but never
# compared.
#
# Published descriptors come from the immutable release manifest's canonical
# descriptor file (`nix/buck2-products`). Source mode is constructed only by
# from-source.nix: its descriptor and revision provenance are validated during
# the importing build against static consumer facts, never read at evaluation.
{ pkgs }:

{
  # Only from-source.nix constructs this mode. Published callers retain the
  # independently pinned descriptor and its evaluation-time validation.
  sourceImport ? null,
  artifact ? null,
  descriptor ? null,
  descriptorContent ? null,
  expectedDescriptorSha256 ? null,
  expectedExternalCapabilities ? [ ],
  expectedExternalModules ? [ ],
  expectedModuleSha256 ? null,
  expectedProductKind,
  expectedProductName,
  expectedRuntimeContract ? "javascript-esm",
  expectedRuntimeContractVersion ? "v1",
  binaryName ? null,
  environment ? { },
  generateCompletions ? binaryName != null,
  # A Buck pnpm_runtime_closure tree and its independently pinned tree digest.
  runtimeClosure ? null,
  nativeNodePackages ? [ ],
  pathPackages ? [ ],
  smokeTestArgs ? null,
}:

if sourceImport != null then
  # No independent descriptor pin: trust comes from the producer build identity
  # (sourceDigest/producerCommit). Static per-field facts and integrity/size
  # checks against payload bytes catch transit tampering. The runtime-closure
  # digest is only a self-consistency check.
  let
    lib = pkgs.lib;
    facts = sourceImport.facts;
    runtime = if facts.expectedRuntimeKind == "bun" then pkgs.bun else pkgs.nodejs_24 or pkgs.nodejs;
    factsFile = pkgs.writeText "javascript-source-import-facts.json" (builtins.toJSON (
      facts // { inherit expectedProductKind expectedProductName expectedExternalCapabilities expectedExternalModules; }
    ));
  in
  pkgs.runCommand "${expectedProductName}-buck2-candidate" {
    nativeBuildInputs = [ pkgs.makeWrapper pkgs.jq pkgs.coreutils pkgs.openssl ];
    passthru.buck2Product = sourceImport.product;
    meta = lib.optionalAttrs (binaryName != null) { mainProgram = binaryName; };
  } ''
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
        --add-flags "${lib.optionalString (facts.expectedRuntimeKind == "bun") "--no-install "}$out/libexec/$module_path" \
        ${lib.concatStringsSep " " (lib.mapAttrsToList (name: entry:
          "--set ${lib.escapeShellArg name} ${lib.escapeShellArg entry}") environment)} \
        ${lib.optionalString (pathPackages != []) "--prefix PATH : ${lib.escapeShellArg (lib.makeBinPath pathPackages)}"}
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
else
let
  lib = pkgs.lib;
  value = builtins.fromJSON descriptorContent;
  expectedKeys = [
    "externalCapabilities"
    "externalModules"
    "integrity"
    "modulePath"
    "platform"
    "productKind"
    "productName"
    "provenance"
    "runtimeContract"
    "runtimeContractVersion"
    "runtimeKind"
    "schema"
    "sizeBytes"
    "target"
  ];
  actualKeys = builtins.attrNames value;
  # The capabilities the product asks THIS consumer to realize. Compared
  # exactly and order-independently: a subset check would let a product grow a
  # host tool nobody here supplies and fail at run time instead of import time.
  normalizedExpectedCapabilities = builtins.sort builtins.lessThan expectedExternalCapabilities;
  normalizedActualCapabilities = builtins.sort builtins.lessThan value.externalCapabilities;
  # The bare imports the product leaves for the host to resolve. Left implicit
  # (`[ ]`) a product would be free to grow a runtime dependency nobody here
  # provides, so this set is compared exactly too.
  normalizedExpectedModules = builtins.sort builtins.lessThan expectedExternalModules;
  normalizedActualModules = builtins.sort builtins.lessThan value.externalModules;
  # The module path is interpolated into the installer script, so it must be a
  # safe relative path: no absolute root, no traversal, no shell metacharacter.
  validRelativePath =
    path:
    builtins.isString path
    && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*(/[A-Za-z0-9][A-Za-z0-9._+-]*)*" path != null;
  runtime = if value.runtimeKind == "bun" then pkgs.bun else pkgs.nodejs_24 or pkgs.nodejs;
  # Bun auto-installs a missing bare import from the network or its global cache
  # when the importing file has no `node_modules` above it. A product ships its
  # own closure, and code it loads at run time (Genie's `.genie.ts` graphs) must
  # fail loudly on a missing package rather than resolve an unpinned version.
  runtimeFlags = lib.optionalString (value.runtimeKind == "bun") "--no-install ";
  wrapperEnvironment = lib.concatStringsSep " \\\n      " (
    lib.mapAttrsToList (
      name: entry: "--set ${lib.escapeShellArg name} ${lib.escapeShellArg entry}"
    ) environment
  );
  wrapperPath = lib.optionalString (
    pathPackages != [ ]
  ) "--prefix PATH : ${lib.escapeShellArg (lib.makeBinPath pathPackages)}";
  nativePackageLinks = lib.concatMapStringsSep "\n" (
    package:
    let
      components = lib.splitString "/" package.name;
      leaf = lib.last components;
      parent = lib.concatStringsSep "/" (lib.init components);
    in
    ''
      mkdir -p "$out/libexec/node_modules/${parent}"
      ln -s ${package.package} "$out/libexec/node_modules/${parent}/${leaf}"
    ''
  ) nativeNodePackages;
  closureInstaller = lib.optionalString (runtimeClosure != null) ''
    ${pkgs.nodejs_24 or pkgs.nodejs}/bin/node ${../../../buck2/dependencies/runtime-closure.ts} \
      --verify ${lib.escapeShellArg "${runtimeClosure.artifact}"} \
      --expected-digest ${lib.escapeShellArg runtimeClosure.expectedDigest}
    cp -R ${lib.escapeShellArg "${runtimeClosure.artifact}"}/. "$out/libexec/"
    chmod u+w "$out/libexec/node_modules"
  '';
  smoke = lib.optionalString (smokeTestArgs != null && binaryName != null) ''
    "$out/bin/${binaryName}" ${lib.escapeShellArgs smokeTestArgs} >/dev/null
  '';
in
assert lib.assertMsg (
  actualKeys == expectedKeys
) "javascript-product-import: descriptor fields are not exact";
assert lib.assertMsg (
  value.schema == "effect-utils/javascript-product/v2"
) "javascript-product-import: unsupported descriptor schema";
assert lib.assertMsg (
  builtins.match "[0-9a-f]{64}" expectedDescriptorSha256 != null
) "javascript-product-import: expectedDescriptorSha256 must be lowercase SHA-256 hex";
assert lib.assertMsg (
  builtins.hashString "sha256" descriptorContent == expectedDescriptorSha256
) "javascript-product-import: descriptor digest mismatch";
assert lib.assertMsg (
  value.productName == expectedProductName
) "javascript-product-import: product name mismatch";
assert lib.assertMsg (
  value.productKind == expectedProductKind
) "javascript-product-import: product kind mismatch";
assert lib.assertMsg (builtins.elem value.runtimeKind [
  "bun"
  "node"
]) "javascript-product-import: unsupported JavaScript runtime";
assert lib.assertMsg (
  value.runtimeContract == expectedRuntimeContract
) "javascript-product-import: runtime contract mismatch";
assert lib.assertMsg (
  value.runtimeContractVersion == expectedRuntimeContractVersion
) "javascript-product-import: runtime contract version mismatch";
assert lib.assertMsg (
  value.platform == {
    abi = "any";
    architecture = "any";
    os = "any";
  }
) "javascript-product-import: product is not platform-invariant";
assert lib.assertMsg (validRelativePath value.modulePath)
  "javascript-product-import: unsafe module path";
assert lib.assertMsg (
  normalizedActualCapabilities == normalizedExpectedCapabilities
) "javascript-product-import: external capability mismatch";
assert lib.assertMsg (
  normalizedActualModules == normalizedExpectedModules
) "javascript-product-import: external module mismatch";
assert lib.assertMsg (
  runtimeClosure == null
  || (
    builtins.isAttrs runtimeClosure
    &&
      builtins.attrNames runtimeClosure == [
        "artifact"
        "expectedDigest"
      ]
    && builtins.match "[0-9a-f]{64}" runtimeClosure.expectedDigest != null
  )
) "javascript-product-import: runtimeClosure needs artifact and expectedDigest";
assert lib.assertMsg (
  builtins.match "[0-9a-f]{64}" expectedModuleSha256 != null
) "javascript-product-import: expectedModuleSha256 must be lowercase SHA-256 hex";
assert lib.assertMsg (
  builtins.isInt value.sizeBytes && value.sizeBytes > 0
) "javascript-product-import: descriptor declares no payload size";
assert lib.assertMsg (
  builtins.match "sha256-[A-Za-z0-9+/]{43}=" value.integrity != null
) "javascript-product-import: integrity must be an SRI SHA-256 digest";
pkgs.runCommand "${expectedProductName}-buck2-candidate"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    passthru = {
      checkedDescriptor = value;
      inherit expectedDescriptorSha256 expectedModuleSha256;
    };
    meta = lib.optionalAttrs (binaryName != null) { mainProgram = binaryName; };
  }
  ''
    set -euo pipefail
    module_path=${lib.escapeShellArg value.modulePath}
    module_dir="$(${pkgs.coreutils}/bin/dirname "$module_path")"
    # The bytes are gated three ways against facts the descriptor itself
    # states: the tracked content address, the descriptor's SRI integrity, and
    # its declared size. Nothing here compares a producer path.
    actual="$(${pkgs.coreutils}/bin/sha256sum ${lib.escapeShellArg "${artifact}"} | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
    if [ "$actual" != ${lib.escapeShellArg expectedModuleSha256} ]; then
      echo "javascript-product-import: module digest mismatch" >&2
      exit 1
    fi
    actual_integrity="sha256-$(${pkgs.openssl}/bin/openssl dgst -sha256 -binary ${lib.escapeShellArg "${artifact}"} \
      | ${pkgs.openssl}/bin/openssl base64 -A)"
    if [ "$actual_integrity" != ${lib.escapeShellArg value.integrity} ]; then
      echo "javascript-product-import: descriptor integrity does not match the module bytes" >&2
      exit 1
    fi
    actual_size="$(${pkgs.coreutils}/bin/stat --format=%s ${lib.escapeShellArg "${artifact}"})"
    if [ "$actual_size" != ${lib.escapeShellArg (toString value.sizeBytes)} ]; then
      echo "javascript-product-import: descriptor size does not match the module bytes" >&2
      exit 1
    fi
    mkdir -p "$out/libexec"
    mkdir -p "$out/libexec/$module_dir"
    cp ${lib.escapeShellArg "${artifact}"} "$out/libexec/$module_path"
    chmod 0444 "$out/libexec/$module_path"
    ${closureInstaller}
    ${nativePackageLinks}
    ${lib.optionalString (binaryName != null) ''
      mkdir -p "$out/bin"
      makeWrapper ${runtime}/bin/${
        if value.runtimeKind == "bun" then "bun" else "node"
      } "$out/bin/${binaryName}" \
        --add-flags "${runtimeFlags}$out/libexec/$module_path" \
        ${wrapperEnvironment} \
        ${wrapperPath}
    ''}
    ${lib.optionalString (generateCompletions && binaryName != null) ''
      mkdir -p "$out/share/fish/vendor_completions.d" "$out/share/bash-completion/completions" "$out/share/zsh/site-functions"
      generate_completion() {
        shell_name="$1"
        target="$2"
        if "$out/bin/${binaryName}" --log-level none --completions "$shell_name" > "$target" 2>/dev/null; then return; fi
        if "$out/bin/${binaryName}" --completions "$shell_name" > "$target" 2>/dev/null; then return; fi
        rm -f "$target"
      }
      generate_completion fish "$out/share/fish/vendor_completions.d/${binaryName}.fish"
      generate_completion bash "$out/share/bash-completion/completions/${binaryName}"
      generate_completion zsh "$out/share/zsh/site-functions/_${binaryName}"
    ''}
    ${smoke}
  ''
