{
  pkgs,
  buck2,
}:

{
  capabilities,
  pnpmArchives,
  # Offline crate supply for Rust products (`mkBuck2CargoArchives`); null
  # when the product has no third-party crates.
  cargoArchives ? null,
  # Native import is constructed here from our own Buck derivation
  # (`native` and `compiled-executable` products).
  importNative ? false,
  expectedPlatform ? null,
  runtimeKind ? null,
  product,
  producerCommit,
  repositoryRoot ? ../..,
  repositorySource ? null,
  expectedSha256 ? null,
  # Optional Buck tree containing the declared pnpm runtime importer closure.
  runtimeClosureTarget ? null,
}:

let
  lib = pkgs.lib;
  cargoWorkspaceRoot = product.cargoWorkspaceRoot or null;
  # Build identity for projections rendered with `cliBuildStamp`: their Rust rules read
  # `CLI_BUILD_STAMP` from `build_identity.cli_build_stamp`, which is empty unless set here.
  cliBuildStamp = product.cliBuildStamp or null;
  source =
    if repositorySource == null then
      lib.fileset.toSource {
        root = repositoryRoot;
        fileset = lib.fileset.unions (
          [
            (repositoryRoot + "/.buckconfig")
            (repositoryRoot + "/.buckroot")
            (repositoryRoot + "/BUCK")
            (repositoryRoot + "/package.json")
            (repositoryRoot + "/pnpm-workspace.yaml")
            (repositoryRoot + "/rust-toolchain.toml")
            (repositoryRoot + "/.oxfmtrc.json")
            (repositoryRoot + "/.oxlintrc.json")
            (repositoryRoot + "/buck2-member.json")
            (repositoryRoot + "/context")
            (repositoryRoot + "/genie/weaver-registry")
            (repositoryRoot + "/devenv.lock")
            (repositoryRoot + "/devenv.yaml")
            (repositoryRoot + "/flake.lock")
            (repositoryRoot + "/flake.nix")
            (repositoryRoot + "/megarepo.kdl")
            (repositoryRoot + "/megarepo.lock")
            (repositoryRoot + "/patches")
            (repositoryRoot + "/nix/weaver-flake/flake.nix")
            (repositoryRoot + "/scripts")
            (repositoryRoot + "/buck2")
            (repositoryRoot + "/packages/@overeng")
          ]
          ++ lib.optionals (cargoWorkspaceRoot != null) [
            (repositoryRoot + "/${cargoWorkspaceRoot}")
          ]
        );
      }
    else
      repositorySource;

  target = product.target;
  productName = product.name;
  outputName = product.outputName;
  safeName = lib.replaceStrings [ "@" "/" ] [ "" "-" ] productName;
  # `build_product` kinds: a Rust `native` executable or a Bun
  # `compiled-executable` (`bun build --compile` of a CLI module).
  isBuildProduct = builtins.elem product.kind [
    "native"
    "compiled-executable"
  ];
  # Descriptor-bearing products: JavaScript product-v2 and build_product.
  hasDescriptor = product.kind == "javascript" || isBuildProduct;
  buckGlobalArgs = "--isolation-dir nix-product-${safeName}";
  buckBuildArgs = "--config nix_store.root=${pnpmArchives}${
    lib.optionalString (cargoWorkspaceRoot != null) " --config external_cells.prelude=disabled"
  }${lib.optionalString (cargoArchives != null) " --config nix_store.crates_root=${cargoArchives}"}${
    lib.optionalString (
      cliBuildStamp != null
    ) " --config ${lib.escapeShellArg "build_identity.cli_build_stamp=${cliBuildStamp}"}"
  } --local-only --no-remote-cache --console simple --show-simple-output";
in
assert lib.assertMsg (
  builtins.match "[0-9a-f]{40}" producerCommit != null
) "buck2-products: producerCommit must be a full lowercase Git commit";
assert lib.assertMsg (
  !isBuildProduct || outputName == "artifact.tar"
) "buck2-products: ${product.kind} products must name the build_product payload artifact.tar";
assert lib.assertMsg (
  cargoWorkspaceRoot == null
  || (
    product.kind == "native"
    && builtins.match "[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@-]+)*" cargoWorkspaceRoot != null
    && lib.all (segment: segment != "." && segment != "..") (lib.splitString "/" cargoWorkspaceRoot)
  )
) "buck2-products: cargoWorkspaceRoot must be a safe relative path on a native product";
assert lib.assertMsg (
  !importNative || isBuildProduct
) "buck2-products: importNative requires a native or compiled-executable product";
assert lib.assertMsg (
  cliBuildStamp == null
  || (
    builtins.isString cliBuildStamp
    && cliBuildStamp != ""
    && builtins.match ".*[\n\r].*" cliBuildStamp == null
  )
) "buck2-products: cliBuildStamp must be a non-empty single-line string";
let
  sourceProduct = pkgs.stdenv.mkDerivation {
    pname = "${safeName}-buck2-from-source";
    version = product.version or "0.0.0";
    src = source;

    nativeBuildInputs = [
      buck2
      pkgs.cacert
      pkgs.jq
    ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR/home"
      export XDG_CACHE_HOME="$TMPDIR/cache"
      export XDG_RUNTIME_DIR="$TMPDIR/runtime"
      export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" .buck2/capabilities
      cp -R ${capabilities}/. .buck2/capabilities
      ${lib.optionalString (cargoWorkspaceRoot != null) ''
        # Buck's bundled Rust prelude emits /usr/bin/env bash scripts, which
        # cannot run inside the Nix sandbox. Patch only its extracted copy.
        ${buck2}/bin/buck2 ${buckGlobalArgs} expand-external-cell prelude
        substituteInPlace prelude/utils/cmd_script.bzl prelude/rust/cargo_buildscript.bzl \
          --replace-fail '#!/usr/bin/env bash' '#!${pkgs.bash}/bin/bash'
        ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
          # Build scripts link against the portable FHS loader, absent in Nix.
          substituteInPlace prelude/rust/tools/buildscript_run.py \
            --replace-fail '            os.path.abspath(buildscript),' \
            '            ["${pkgs.stdenv.cc.bintools.dynamicLinker}", "--library-path", "${pkgs.stdenv.cc.cc.lib}/lib", os.path.abspath(buildscript)],'
        ''}
      ''}

      artifact="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} ${lib.escapeShellArg target})"
      test -f "$artifact"
      cp "$artifact" ${lib.escapeShellArg outputName}
      ${lib.optionalString hasDescriptor ''
        descriptor="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} ${lib.escapeShellArg "${target}[descriptor]"})"
        test -f "$descriptor"
        jq -cS . "$descriptor" > descriptor.json
      ''}
      ${lib.optionalString (runtimeClosureTarget != null) ''
        runtime_closure="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} ${lib.escapeShellArg runtimeClosureTarget})"
        test -f "$runtime_closure/descriptor.json"
        cp -R "$runtime_closure" runtime-closure
      ''}
      actual_sha256="$(sha256sum ${lib.escapeShellArg outputName} | cut -d' ' -f1)"
      ${lib.optionalString (expectedSha256 != null) ''
        test "$actual_sha256" = ${lib.escapeShellArg expectedSha256}
      ''}
      jq -nS \
        --arg schema 'effect-utils/buck-product-provenance/v1' \
        --arg producerCommit ${lib.escapeShellArg producerCommit} \
        --arg target ${lib.escapeShellArg target} \
        --arg productDigest "$actual_sha256" \
        '{schema:$schema,producerCommit:$producerCommit,target:$target,productDigest:$productDigest}' \
        > provenance.json
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp ${lib.escapeShellArg outputName} "$out/${outputName}"
      cp provenance.json "$out/provenance.json"
      ${lib.optionalString hasDescriptor ''
        cp descriptor.json "$out/descriptor.json"
      ''}
      ${lib.optionalString (runtimeClosureTarget != null) ''
        cp -R runtime-closure "$out/runtime-closure"
      ''}
      runHook postInstall
    '';

    passthru = {
      inherit
        capabilities
        cargoArchives
        pnpmArchives
        producerCommit
        repositorySource
        source
        target
        runtimeClosureTarget
        ;
      artifactName = outputName;
      inherit productName;
      productKind = product.kind;
      expectedProductSha256 = expectedSha256;
    };
  };
in
if importNative then
  (import ../workspace-tools/lib/buck2-artifact-realize.nix { inherit pkgs; }) {
    name = productName;
    expectedTarget = target;
    expectedPlatform =
      if expectedPlatform == null then
        let
          host = pkgs.stdenv.hostPlatform;
        in
        {
          os = if host.isDarwin then "darwin" else "linux";
          architecture = host.parsed.cpu.name;
          abi = if host.isDarwin then "darwin" else host.libc;
        }
      else
        expectedPlatform;
    runtimeKind =
      if runtimeKind == null then
        (if pkgs.stdenv.hostPlatform.isDarwin then "mach-o-dynamic" else "elf-dynamic")
      else
        runtimeKind;
    descriptorPath = lib.escapeShellArg "${sourceProduct}/descriptor.json";
    archivePath = lib.escapeShellArg "${sourceProduct}/${outputName}";
    passthru.buck2Product = sourceProduct;
  }
else
  sourceProduct
