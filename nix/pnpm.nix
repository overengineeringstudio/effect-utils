{ pkgs }:

# Pinned pnpm version for the entire megarepo ecosystem.
# This is the SSOT for the pnpm CLI version — all downstream repos should use
# this instead of pkgs.pnpm to ensure consistent behavior across devenv shells,
# CI, and Nix builds.
#
# The version here MUST match DEFAULT_AGGREGATE_PACKAGE_MANAGER in
# packages/@overeng/genie/src/runtime/package-json/mod.ts.
#
# pnpm 12 is a native (Rust) executable. The `pnpm` npm package no longer
# contains the CLI: it carries the Corepack entrypoint (`bin/pnpm.mjs`), the
# `sh` placeholder bins, and the bundled `dist/` payload (node-gyp), while the
# executable ships in a per-host `@pnpm/exe.<target>` package declared as an
# optional dependency. `pkgs.pnpm` builds the pre-12 JavaScript layout, so this
# assembles the published layout directly instead of overriding it: the native
# binary is placed at the wrapper root exactly where the upstream `install.js`
# preinstall hard-links it, so both the binary's own `dist/` lookup and
# `bin/pnpm.mjs`'s `resolveInstalledBinary()` keep working without any
# lifecycle script or network access at build time.
# The linux-arm64 payload is bundled alongside the eval-platform one:
# `resolveInstalledBinary()` probes the host's target directory, and a
# wrapper evaluated on x86_64 but executed on aarch64 (remote builders)
# must find a working binary there. Without it, resolution walks into
# ancestor `node_modules` and spawns whatever half-installed copy it finds
# (typically missing its optional exe or carrying an unpatched interpreter),
# failing with a bare spawnSync ENOENT.
let
  lib = pkgs.lib;
  version = "12.4.1";

  platform = pkgs.stdenv.hostPlatform;

  unsupportedPlatform = throw "nix/pnpm.nix: pnpm ${version} ships no native binary for ${platform.system}";
  target =
    if platform.system == "aarch64-darwin" then
      "darwin-arm64"
    else if platform.system == "x86_64-darwin" then
      "darwin-x64"
    else if platform.system == "aarch64-linux" then
      if platform.isMusl then "linux-arm64-musl" else "linux-arm64"
    else if platform.system == "x86_64-linux" then
      if platform.isMusl then "linux-x64-musl" else "linux-x64"
    else
      unsupportedPlatform;

  exeHashes = {
    "linux-x64" = "sha256-YU0YvcsSGoRMAmCzFddrc35oc0bAAbjgk/0KkyAsLWs=";
    "linux-arm64" = "sha256-79UEsfvqNGHdoyIESBE3Q0VXz8HtcKsD8Nxvlt0r6EU=";
    "linux-x64-musl" = "sha256-nfj+T4u+WBXRafC4cC2niEQtJplT4gZYawUYlSdCjJg=";
    "linux-arm64-musl" = "sha256-mD9RMUbOd4mBXx2I8dXkN12zO4DkS+lUrBhtx0EdMrY=";
    "darwin-x64" = "sha256-/4zVEgEpiwOvh/QkJ/w53LcA/w8dZCT6u9CF039RjLQ=";
    "darwin-arm64" = "sha256-nI4gCXq7OtTzC/oxw+WT016REfuGdaBq1rOR/N17yKA=";
  };

  wrapperSrc = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
    hash = "sha256-YnYpjpr1dren9ekES/r74meCCSUM0QsXBepdOqZNSII=";
  };

  exeSrc = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@pnpm/exe.${target}/-/exe.${target}-${version}.tgz";
    hash = exeHashes.${target};
  };

  # The linux-arm64 executable is bundled only for the glibc x86_64 build,
  # whose wrapper is the one consumed cross-platform by aarch64 builders:
  # `resolveInstalledBinary()` probes the host's target directory, so it
  # must find a working binary there. Other targets resolve natively
  # (aarch64-linux, both darwins) or are out of scope (musl), so bundling
  # there would only retain the cross glibc/GCC libraries for no benefit.
  # All references below are lazy: nothing is fetched unless bundled.
  wantArm64Exe = target == "linux-x64";
  arm64ExeSrc = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-${version}.tgz";
    hash = exeHashes."linux-arm64";
  };
  # Runtime closure for the foreign binary (interpreter + libgcc_s). Only
  # referenced when the extra copy is bundled.
  arm64Glibc = pkgs.pkgsCross.aarch64-multiplatform.glibc;
  arm64GccLib = pkgs.pkgsCross.aarch64-multiplatform.gcc.cc.lib;
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "pnpm";
  inherit version;

  dontUnpack = true;

  nativeBuildInputs = [ pkgs.makeWrapper ] ++ lib.optional platform.isLinux pkgs.autoPatchelfHook;
  buildInputs = lib.optional platform.isLinux (lib.getLib pkgs.stdenv.cc.cc);

  installPhase = ''
    runHook preInstall

    wrapper=$out/libexec/pnpm
    mkdir -p "$wrapper"
    tar -xzf ${wrapperSrc} -C "$wrapper" --strip-components=1

    # The published `pnpm` file is the shebang-less placeholder that upstream's
    # preinstall replaces with the native binary; do that replacement here.
    rm "$wrapper/pnpm"
    tar -xzf ${exeSrc} -C "$wrapper" --strip-components=1 package/pnpm
    chmod +x "$wrapper/pnpm"

    # `bin/pnpm.mjs` (Corepack's entrypoint, and the one mk-pnpm-deps invokes
    # through PNPM_MJS) only looks for the binary inside the platform package,
    # so point that location at the single copy.
    exeDir=$wrapper/node_modules/@pnpm/exe.${target}
    mkdir -p "$exeDir"
    ln -s ../../../pnpm "$exeDir/pnpm"

    # A glibc x86_64 wrapper still needs a working binary on aarch64
    # builders: unpack the linux-arm64 payload into its platform directory
    # and point it at the cross glibc loader. autoPatchelfHook only covers
    # the eval-platform binary and cannot run foreign binaries, so this is
    # explicit. musl and darwin targets stay single-copy.
    ${lib.optionalString wantArm64Exe ''
      arm64Dir=$wrapper/node_modules/@pnpm/exe.linux-arm64
      mkdir -p "$arm64Dir"
      tar -xzf ${arm64ExeSrc} -C "$arm64Dir" --strip-components=1 package/pnpm
      chmod +x "$arm64Dir/pnpm"
      ${pkgs.patchelf}/bin/patchelf \
        --set-interpreter "${arm64Glibc}/lib/ld-linux-aarch64.so.1" \
        --set-rpath "${arm64Glibc}/lib:${arm64GccLib}/lib" \
        "$arm64Dir/pnpm"
    ''}

    chmod +x "$wrapper/bin/pnpm.mjs" "$wrapper/bin/pnpx.mjs"

    # This derivation already provides the exact workspace-authoritative pnpm.
    # Disable pnpm's package-manager bootstrap so sandboxed invocations do not
    # try to download a second copy of the same version.
    makeWrapper "$wrapper/pnpm" $out/bin/pnpm \
      --set pnpm_config_pm_on_fail ignore
    makeWrapper "$wrapper/pnpm" $out/bin/pn \
      --set pnpm_config_pm_on_fail ignore
    makeWrapper "$wrapper/pnpm" $out/bin/pnpx \
      --set pnpm_config_pm_on_fail ignore \
      --add-flags dlx
    makeWrapper "$wrapper/pnpm" $out/bin/pnx \
      --set pnpm_config_pm_on_fail ignore \
      --add-flags dlx

    runHook postInstall
  '';

  meta = {
    description = "Fast, disk space efficient package manager (pinned megarepo build)";
    homepage = "https://pnpm.io";
    license = lib.licenses.mit;
    mainProgram = "pnpm";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
