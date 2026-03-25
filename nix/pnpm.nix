{ pkgs }:

# Pinned pnpm version for the entire megarepo ecosystem.
# This is the SSOT for the pnpm CLI version — all downstream repos should use
# this instead of pkgs.pnpm to ensure consistent behavior across devenv shells,
# CI, and Nix builds.
#
# The version here MUST match DEFAULT_AGGREGATE_PACKAGE_MANAGER in
# packages/@overeng/genie/src/runtime/package-json/mod.ts.
pkgs.pnpm.overrideAttrs (old: {
  version = "11.0.0-beta.2";
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-11.0.0-beta.2.tgz";
    hash = "sha256-0fp4evy2xE292b7kcNbLuUgO62+cbz7Vsga27x40w8A=";
  };
  # pnpm 11 ships .cjs bins without execute permission (unlike v10).
  # The nixpkgs installPhase symlinks bin/pnpm -> libexec/pnpm/bin/pnpm.cjs,
  # so the .cjs files must be executable for the shebang to work.
  installPhase = builtins.replaceStrings
    [ "runHook postInstall" ]
    [ ''
      chmod +x $out/libexec/pnpm/bin/pnpm.cjs
      chmod +x $out/libexec/pnpm/bin/pnpx.cjs
      runHook postInstall
    '' ]
    old.installPhase;
})
