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
  producerCommit ? null,
  repositoryRoot ? ../..,
  repositorySource ? null,
  # Committed Genie projection of the Buck input closure, relative to repositoryRoot.
  sourcePaths ? null,
  # Consumer Buck root is a separate Nix input, not a copy of the checkout.
  rootProjection ? null,
  expectedSha256 ? null,
  # Optional Buck tree containing the declared pnpm runtime importer closure.
  runtimeClosureTarget ? null,
  # Nix-built native packages used by lockfile store entries (not view links).
  nativeStorePackages ? [ ],
}:

let
  lib = pkgs.lib;
  watcherPolicies = import ./watcher-policies.nix;
  cargoWorkspaceRoot = product.cargoWorkspaceRoot or null;
  # Cargo manifests in consumer roots live in repositorySource, which can be a
  # derivation. Read the staged workspace at build time, not repositoryRoot at
  # evaluation time: the latter belongs to this rules package.
  releaseProfileScript = ../workspace-tools/lib/cargo-release-profile.py;
  # Build identity for projections rendered with `cliBuildStamp`: their Rust rules read
  # `CLI_BUILD_STAMP` from `build_identity.cli_build_stamp`, which is empty unless set here.
  cliBuildStamp = product.cliBuildStamp or null;
  source =
    if sourcePaths != null then
      lib.fileset.toSource {
        root = repositoryRoot;
        fileset = lib.fileset.unions (map (path: repositoryRoot + "/${path}") sourcePaths);
      }
    else if repositorySource != null then
      repositorySource
    else
      lib.fileset.toSource {
        root = repositoryRoot;
        fileset = lib.fileset.unions (
          [
            (repositoryRoot + "/.buckconfig")
            (repositoryRoot + "/.buckroot")
            (repositoryRoot + "/.watchmanconfig")
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
      };
  sourceDigest = builtins.hashString "sha256" (toString source);

  target = product.target;
  productName = product.name;
  outputName = product.outputName;
  safeName = lib.replaceStrings [ "@" "/" ] [ "" "-" ] productName;
  # `build_product` kinds: a Rust `native` executable, a Bun
  # `compiled-executable` (`bun build --compile` of a CLI module), or a
  # `swift-app-bundle` Darwin app bundle.
  isBuildProduct = builtins.elem product.kind [
    "native"
    "compiled-executable"
    "swift-app-bundle"
  ];
  # Descriptor-bearing products: JavaScript product-v2 and build_product.
  hasDescriptor = product.kind == "javascript" || isBuildProduct;
  buckGlobalArgs = "--isolation-dir nix-product-${safeName}";
  buckBuildArgs = "-j \"$NIX_BUILD_CORES\" --config build.num_tokio_workers=\"$NIX_BUILD_CORES\" --config nix_store.root=${pnpmArchives}${
    lib.optionalString (product.kind == "native") " --config rust_profile.mode=release"
  }${
    lib.concatMapStringsSep "" (
      package: " --config ${lib.escapeShellArg "test_capabilities.${package.name}=${package.package}"}"
    ) nativeStorePackages
  }${lib.optionalString (cargoWorkspaceRoot != null) " --config external_cells.prelude=disabled"}${
    lib.optionalString (cargoArchives != null) " --config nix_store.crates_root=${cargoArchives}"
  }${
    lib.optionalString (
      cliBuildStamp != null
    ) " --config ${lib.escapeShellArg "build_identity.cli_build_stamp=${cliBuildStamp}"}"
  } --local-only --no-remote-cache --console simple --show-simple-output";
in
assert lib.assertMsg (
  producerCommit == null || builtins.match "[0-9a-f]{40}" producerCommit != null
) "buck2-products: producerCommit must be a full lowercase Git commit";
assert lib.assertMsg (
  (producerCommit == null) == (sourcePaths != null)
) "buck2-products: published recipes require producerCommit; scoped consumer recipes must omit it";
assert lib.assertMsg
  (
    sourcePaths == null
    || (
      builtins.isList sourcePaths
      && sourcePaths != [ ]
      && lib.all (
        path:
        builtins.isString path
        && builtins.match "[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@-]+)*" path != null
        && lib.all (segment: segment != "." && segment != "..") (lib.splitString "/" path)
      ) sourcePaths
      && repositorySource == null
    )
  )
  "buck2-products: sourcePaths must be nonempty safe relative paths and cannot be combined with repositorySource";
assert lib.assertMsg (
  (sourcePaths == null) == (rootProjection == null)
) "buck2-products: scoped sourcePaths require a separate rootProjection";
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
assert lib.assertMsg (!importNative || isBuildProduct)
  "buck2-products: importNative requires a native, compiled-executable, or swift-app-bundle product";
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
    ]
    ++ lib.optionals (cargoWorkspaceRoot != null) [ pkgs.python3 ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      # Nix's zero/unset budget must not expand to the host's CPU count.
      export NIX_BUILD_CORES="''${NIX_BUILD_CORES:-1}"
      if [ "$NIX_BUILD_CORES" = 0 ]; then
        export NIX_BUILD_CORES=1
      fi
      # Bound daemon blocking work as well as execution and Tokio workers.
      export BUCK2_MAX_BLOCKING_THREADS="$NIX_BUILD_CORES"
      export HOME="$TMPDIR/home"
      export XDG_CACHE_HOME="$TMPDIR/cache"
      export XDG_RUNTIME_DIR="$TMPDIR/runtime"
      export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      ${lib.optionalString (rootProjection != null) ''
        cp -R ${rootProjection}/. .
        chmod -R u+w .buck2 buck2 BUCK .buckconfig .buckroot
      ''}
      mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" .buck2/capabilities
      cp -R ${capabilities}/. .buck2/capabilities
      # Nix inputs are immutable and Watchman's state-directory chmod is not
      # permitted in the sandbox. Hash only this declared source tree instead
      # of requiring a native notification daemon; mutable edit loops use the
      # shipped Watchman policy. Startup reads the file, not CLI -c overrides.
      cat >> .buckconfig.local <<'BUCKLOCAL'
      [buck2]
        file_watcher = ${watcherPolicies.immutable-input}
      BUCKLOCAL
      ${lib.optionalString (cargoWorkspaceRoot != null) ''
        # Consumer roots carry the already-patched local prelude from
        # buck2-rules. Only the producer's bundled external prelude needs
        # extraction and patching before a sandboxed Rust build.
        if [ ! -d .buck2/rules/prelude ]; then
          ${buck2}/bin/buck2 ${buckGlobalArgs} expand-external-cell prelude
          substituteInPlace prelude/utils/cmd_script.bzl prelude/rust/cargo_buildscript.bzl \
            --replace-fail '#!/usr/bin/env bash' '#!${pkgs.bash}/bin/bash'
          ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            # Build scripts link against the portable FHS loader, absent in Nix.
            substituteInPlace prelude/rust/tools/buildscript_run.py \
              --replace-fail '            os.path.abspath(buildscript),' \
              '            ["${pkgs.stdenv.cc.bintools.dynamicLinker}", "--library-path", "${pkgs.stdenv.cc.cc.lib}/lib", os.path.abspath(buildscript)],'
          ''}
        fi
      ''}

      rust_profile_args=()
      ${lib.optionalString (cargoWorkspaceRoot != null) ''
        release_settings="$(${pkgs.python3}/bin/python3 ${releaseProfileScript} ${lib.escapeShellArg "${cargoWorkspaceRoot}/Cargo.toml"})"
        while IFS= read -r setting; do
          rust_profile_args+=(--config "$setting")
        done <<< "$release_settings"
      ''}

      artifact="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} "''${rust_profile_args[@]}" ${lib.escapeShellArg target})"
      test -f "$artifact"
      cp "$artifact" ${lib.escapeShellArg outputName}
      ${lib.optionalString hasDescriptor ''
        descriptor="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} "''${rust_profile_args[@]}" ${lib.escapeShellArg "${target}[descriptor]"})"
        test -f "$descriptor"
        jq -cS . "$descriptor" > descriptor.json
      ''}
      ${lib.optionalString (runtimeClosureTarget != null) ''
        runtime_closure="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} "''${rust_profile_args[@]}" ${lib.escapeShellArg runtimeClosureTarget})"
        test -f "$runtime_closure/descriptor.json"
        cp -R "$runtime_closure" runtime-closure
      ''}
      actual_sha256="$(sha256sum ${lib.escapeShellArg outputName} | cut -d' ' -f1)"
      ${lib.optionalString (expectedSha256 != null) ''
        test "$actual_sha256" = ${lib.escapeShellArg expectedSha256}
      ''}
      ${
        if producerCommit == null then
          ''
            jq -nS \
              --arg schema 'effect-utils/buck-product-source-provenance/v1' \
              --arg sourceDigest ${lib.escapeShellArg sourceDigest} \
              --arg target ${lib.escapeShellArg target} \
              --arg productDigest "$actual_sha256" \
              '{schema:$schema,sourceDigest:$sourceDigest,target:$target,productDigest:$productDigest}' \
              > provenance.json
          ''
        else
          ''
            jq -nS \
              --arg schema 'effect-utils/buck-product-provenance/v1' \
              --arg producerCommit ${lib.escapeShellArg producerCommit} \
              --arg target ${lib.escapeShellArg target} \
              --arg productDigest "$actual_sha256" \
              '{schema:$schema,producerCommit:$producerCommit,target:$target,productDigest:$productDigest}' \
              > provenance.json
          ''
      }
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
        nativeStorePackages
        pnpmArchives
        producerCommit
        repositorySource
        rootProjection
        source
        sourceDigest
        sourcePaths
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
      if runtimeKind != null then
        runtimeKind
      else if product.kind == "swift-app-bundle" then
        "mach-o-app-bundle"
      else if pkgs.stdenv.hostPlatform.isDarwin then
        "mach-o-dynamic"
      else
        "elf-dynamic";
    descriptorPath = lib.escapeShellArg "${sourceProduct}/descriptor.json";
    archivePath = lib.escapeShellArg "${sourceProduct}/${outputName}";
    passthru.buck2Product = sourceProduct;
  }
else
  sourceProduct
