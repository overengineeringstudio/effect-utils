{ pkgs }:
# The Bun runtime a `bun build --compile` action embeds into a compiled product.
#
# `bun build --compile` copies its base executable and appends the bundle, so a
# product compiled against `pkgs.bun` inherits nixpkgs' patched PT_INTERP
# (`/nix/store/...-glibc/lib/ld-linux-*.so`) and fails the categorical
# store-reference scan of `buck2-artifact-scan.nix`. The official release binary
# carries the standard loader and no store paths, so its compiled products
# satisfy `elf-dynamic/v1` / `mach-o-dynamic/v1` unchanged. It is only ever read
# as `--compile-executable-path`; Nix's Bun still bundles.
#
# Same shape as `nix/go.nix` (decision 0029): one `fetchurl` per admitted
# platform, pinned by the sha256 published in the release's SHASUMS256.txt,
# unpacked verbatim. Nothing may rewrite the binary: a patched copy is a
# different runtime, and patching the Darwin binary invalidates its signature.
let
  release = {
    version = "1.4.4";
    baseUrl = "https://github.com/oven-sh/bun/releases/download";
    platforms = {
      x86_64-linux = {
        bunPlatform = "linux-x64";
        sha256 = "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c";
      };
      aarch64-linux = {
        bunPlatform = "linux-aarch64";
        sha256 = "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e";
      };
      aarch64-darwin = {
        bunPlatform = "darwin-aarch64";
        sha256 = "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510";
      };
    };
  };
  system = pkgs.stdenv.hostPlatform.system;
  platform =
    release.platforms.${system}
      or (throw "Bun compile runtime ${release.version} is not admitted for ${system}");
  archive = pkgs.fetchurl {
    url = "${release.baseUrl}/bun-v${release.version}/bun-${platform.bunPlatform}.zip";
    inherit (platform) sha256;
  };
  # The compiled bundle's module-graph format belongs to the bundler, so the
  # embedded runtime must be the same release as the bundling `pkgs.bun`.
  versionMatches = pkgs.bun.version == release.version;
  # The Linux release binary names the FHS loader, absent on NixOS; the check
  # runs it through the Nix loader instead of rewriting it.
  runRuntime =
    if pkgs.stdenv.hostPlatform.isLinux then
      "${pkgs.stdenv.cc.bintools.dynamicLinker} \"$out/bin/bun\""
    else
      "\"$out/bin/bun\"";
in
assert pkgs.lib.assertMsg versionMatches
  "Bun compile runtime ${release.version} must match the bundling pkgs.bun ${pkgs.bun.version}; bump nix/bun-compile-runtime.nix";
pkgs.stdenvNoCC.mkDerivation {
  pname = "bun-compile-runtime";
  version = release.version;
  src = archive;

  nativeBuildInputs = [ pkgs.unzip ];
  sourceRoot = "bun-${platform.bunPlatform}";

  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  dontPatchELF = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    install -Dm555 bun "$out/bin/bun"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    actual="$(${runRuntime} --version)"
    [ "$actual" = ${pkgs.lib.escapeShellArg release.version} ] || {
      echo "Bun compile runtime reports $actual, expected ${release.version}" >&2
      exit 1
    }
    if grep -q --binary-files=text /nix/store/ "$out/bin/bun"; then
      echo "official Bun release references the Nix store" >&2
      exit 1
    fi
    runHook postInstallCheck
  '';

  passthru = {
    inherit (release) version;
    inherit (platform) bunPlatform;
  };

  meta = {
    description = "Official Bun ${release.version} release binary for ${platform.bunPlatform}, the base of compiled products";
    homepage = "https://github.com/oven-sh/bun/releases";
    license = pkgs.lib.licenses.mit;
    platforms = builtins.attrNames release.platforms;
    mainProgram = "bun";
  };
}
