{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pnpm-lock-projector";
  version = "0.1.0";

  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter =
      path: _type:
      builtins.elem (baseNameOf path) [
        "package.json"
        "package-lock.json"
        "project-lockfile.mjs"
      ];
  };
  npmDepsHash = "sha256-yUnILl80Yao/vmB9U4qPLQew0d3cBXHLiWHkfKvdxgc=";

  dontNpmBuild = true;
  npmRebuildFlags = [ "--ignore-scripts" ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pnpm-lock-projector"
    cp -R node_modules package.json package-lock.json project-lockfile.mjs \
      "$out/lib/pnpm-lock-projector/"

    runHook postInstall
  '';
}
