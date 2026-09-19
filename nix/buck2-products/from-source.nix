{
  pkgs,
  buck2,
  preparedDeps,
}:

let
  lib = pkgs.lib;
  repositoryRoot = ../..;
  source = lib.fileset.toSource {
    root = repositoryRoot;
    fileset = lib.fileset.unions [
      (repositoryRoot + "/BUCK")
      (repositoryRoot + "/buck2")
      (repositoryRoot + "/packages/@overeng/buck2-tools")
      (repositoryRoot + "/packages/@overeng/oxc-config")
    ];
  };
  prelude = buck2.passthru.prelude;
  generation = builtins.hashString "sha256" "nix-reconstruction:${pkgs.bun}";
  bunClosure = pkgs.closureInfo { rootPaths = [ pkgs.bun ]; };
  target = "effect_utils//packages/@overeng/oxc-config:oxc-config-candidate";
in
pkgs.stdenv.mkDerivation {
  pname = "oxc-config-buck2-from-source";
  version = "0.1.0";
  src = source;

  nativeBuildInputs = [
    buck2
    pkgs.bun
    pkgs.cacert
    pkgs.gnutar
    pkgs.gzip
  ];

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    export XDG_CACHE_HOME="$TMPDIR/cache"
    export XDG_RUNTIME_DIR="$TMPDIR/runtime"
    export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"

    touch .buckroot
    cat > .buckconfig <<'BUCKCONFIG'
    [cells]
      effect_utils = .
      capabilities = .buck2/capabilities
      prelude = prelude

    [cell_aliases]
      config = prelude
      ovr_config = prelude
      fbsource = prelude
      toolchains = effect_utils

    [parser]
      target_platform_detector_spec = target:effect_utils//...->effect_utils//buck2/platforms:host_platform

    [build]
      execution_platforms = effect_utils//buck2/platforms:host_execution_platform

    [buck2]
      file_watcher = notify
      digest_algorithms = SHA256
      remote_cache_enabled = false
      allow_cache_uploads = false

    [project]
      ignore = **/__pycache__,**/dist,**/node_modules,**/node_modules/**,**/target,**/target/**,.devenv,.git,buck-out,node_modules,packages/.editor-view,target,tmp
    BUCKCONFIG

    mkdir -p prelude
    tar -xzf ${prelude} --strip-components=1 -C prelude

    mkdir -p .buck2/capabilities
    cat > .buck2/capabilities/defs.bzl <<'CAPABILITIES_HEAD'
    GENERATION = "${generation}"
    CAPABILITIES = {
      "${if pkgs.stdenv.hostPlatform.isDarwin then "aarch64-macos" else pkgs.stdenv.hostPlatform.system}": {
        "bun": {
          "generation": "${generation}",
          "contentDigest": "@bunDigest@",
          "closureIdentity": "${pkgs.bun}",
          "executableStorePath": "${pkgs.bun}/bin/bun",
          "closureStorePaths": [
    CAPABILITIES_HEAD
    sort -u ${bunClosure}/store-paths | sed 's|^|          "|; s|$|",|' >> .buck2/capabilities/defs.bzl
    cat >> .buck2/capabilities/defs.bzl <<'CAPABILITIES_TAIL'
          ],
        },
      },
    }
    CAPABILITIES_TAIL
    substituteInPlace .buck2/capabilities/defs.bzl \
      --replace-fail '@bunDigest@' "$(sha256sum ${pkgs.bun}/bin/bun | cut -d' ' -f1)"

    cat > buck2/toolchains/BUCK <<'TOOLCHAINS'
    load("//buck2/toolchains:defs.bzl", "bun_toolchain")
    load("@capabilities//:defs.bzl", "CAPABILITIES", "GENERATION")
    bun_toolchain(
        name = "bun",
        capabilities = CAPABILITIES,
        generation = GENERATION,
        visibility = ["PUBLIC"],
    )
    TOOLCHAINS

    cat > buck2/dependencies/BUCK <<'DEPENDENCIES'
    load("//buck2/dependencies:defs.bzl", "pnpm_platform_gated_packages")

    pnpm_platform_gated_packages(
        name = "platform_gated_packages",
        capabilities = {},
        families = {},
        visibility = ["PUBLIC"],
    )
    DEPENDENCIES

    mkdir -p nix-deps
    cp -a ${preparedDeps}/node_modules nix-deps/tree
    chmod u+w nix-deps/tree/.pnpm/node_modules/@overeng
    rm nix-deps/tree/.pnpm/node_modules/@overeng/oxc-config

    cat > buck2/nix_source.bzl <<'NIX_SOURCE'
    def _source_directory_impl(ctx):
        return [DefaultInfo(default_output = ctx.attrs.src)]

    source_directory = rule(
        impl = _source_directory_impl,
        attrs = {
            "src": attrs.source(allow_directory = True),
        },
    )
    NIX_SOURCE

    {
      echo 'load("//buck2:nix_source.bzl", "source_directory")'
      cat BUCK
    } > BUCK.with-nix-source
    mv BUCK.with-nix-source BUCK
    cat >> BUCK <<'ROOT_TARGET'

    source_directory(
        name = "nix_prepared_node_modules",
        src = "nix-deps/tree",
        visibility = ["PUBLIC"],
    )
    ROOT_TARGET

    substituteInPlace packages/@overeng/oxc-config/BUCK \
      --replace-fail 'load("//buck2:materialization.bzl", "export_materialization_inputs", "package_view")' \
                     'load("//buck2:materialization.bzl", "export_materialization_inputs", "package_tree")' \
      --replace-fail 'package_view(' 'package_tree(' \
      --replace-fail 'dependency_view = "//buck2/dependencies:view_packages_overeng_oxc_config_0c9db47f45b6",' \
                     'node_modules = "//:nix_prepared_node_modules",'

    product="$(${buck2}/bin/buck2 --isolation-dir nix-reconstruction build ${target} --local-only --no-remote-cache --console simple --show-simple-output)"
    test -f "$product"
    cp "$product" oxc-config.js
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp oxc-config.js "$out/oxc-config.js"
    runHook postInstall
  '';

  passthru = {
    inherit preparedDeps source target;
    capabilityProjection = {
      bun = pkgs.bun;
      inherit generation;
    };
    prelude = prelude;
  };
}
