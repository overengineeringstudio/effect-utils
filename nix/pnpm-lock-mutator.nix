{ pkgs }:

# pnpm 11.5.2 through 11.14.0 corrupt `hasBin` metadata when
# `install --fix-lockfile` rewrites unchanged package records (pnpm/pnpm#6600).
# Keep lockfile mutation on the last verified-safe pnpm 11 release. Runtime
# frozen installs intentionally remain on the repository's current pnpm pin.
pkgs.pnpm.overrideAttrs (old: {
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.makeWrapper ];
  version = "11.5.1";
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-11.5.1.tgz";
    hash = "sha256-3npcG+2DAYBRg6h5l/4XIM1crvtXvoOFNaS/xKFZaVk=";
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
