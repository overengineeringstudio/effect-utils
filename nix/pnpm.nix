{ pkgs }:

# Pinned pnpm version for the entire megarepo ecosystem.
# This is the SSOT for the pnpm CLI version — all downstream repos should use
# this instead of pkgs.pnpm to ensure consistent behavior across devenv shells,
# CI, and Nix builds.
#
# The version here MUST match DEFAULT_AGGREGATE_PACKAGE_MANAGER in
# packages/@overeng/genie/src/runtime/package-json/mod.ts.
pkgs.pnpm.overrideAttrs (old: {
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.makeWrapper ];
  version = "11.0.0-beta.2";
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-11.0.0-beta.2.tgz";
    hash = "sha256-0fp4evy2xE292b7kcNbLuUgO62+cbz7Vsga27x40w8A=";
  };
  postInstall = (old.postInstall or "") + ''
    chmod +x $out/libexec/pnpm/bin/pnpm.cjs
    chmod +x $out/libexec/pnpm/bin/pnpx.cjs
    chmod +x $out/libexec/pnpm/bin/pnpm.mjs
    chmod +x $out/libexec/pnpm/bin/pnpx.mjs
    rm $out/bin/pnpm
    rm $out/bin/pnpx
    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/pnpm \
      --add-flags $out/libexec/pnpm/bin/pnpm.mjs
    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/pnpx \
      --add-flags $out/libexec/pnpm/bin/pnpx.mjs
  '';
  installPhase =
    builtins.replaceStrings
      [ "runHook postInstall" ]
      [
        ''
          runHook postInstall
        ''
      ]
      old.installPhase;
})
