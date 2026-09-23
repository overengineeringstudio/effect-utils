{
  pkgs,
  source,
  prelude,
  generation,
}:

let
  bunClosure = pkgs.closureInfo { rootPaths = [ pkgs.bun ]; };
  hostPlatform =
    if pkgs.stdenv.hostPlatform.isDarwin then "aarch64-macos" else pkgs.stdenv.hostPlatform.system;
in
pkgs.runCommand "effect-utils-buck2-standalone-root"
  {
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.gzip
    ];
    passthru = {
      inherit generation source;
      bun = pkgs.bun;
    };
  }
  ''
    cp -R ${source}/. "$out"
    chmod -R u+w "$out"
    cd "$out"

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
      ignore = **/__pycache__,**/dist,**/target,**/target/**,.devenv,.git,buck-out,node_modules,packages/.editor-view,target,tmp
    BUCKCONFIG

    mkdir -p prelude
    tar -xzf ${prelude} --strip-components=1 -C prelude

    mkdir -p .buck2/capabilities
    cat > .buck2/capabilities/defs.bzl <<'CAPABILITIES_HEAD'
    GENERATION = "${generation}"
    CAPABILITIES = {
      "${hostPlatform}": {
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
  ''
