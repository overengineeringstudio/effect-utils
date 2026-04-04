{
  description = "mk-pnpm-cli downstream flake-input fixture";

  inputs = {
    effect-utils.url = "path:../effect-utils";
    nixpkgs.follows = "effect-utils/nixpkgs";
    flake-utils.follows = "effect-utils/flake-utils";
  };

  outputs =
    {
      nixpkgs,
    flake-utils,
      effect-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
        effectUtilsPackages = effect-utils.packages.${system};
        effectUtilsSource = effect-utils;
        pinnedPnpm = import "${effectUtilsSource}/nix/pnpm.nix" { inherit pkgs; };
        mkPnpmCliFactory = import "${effectUtilsSource}/nix/workspace-tools/lib/mk-pnpm-cli.nix";
        mkPnpmCli = mkPnpmCliFactory (
          {
            pkgs = pkgs // {
              bun = pkgs.bun;
              pnpm = pinnedPnpm;
            };
          }
          // lib.optionalAttrs (builtins.hasAttr "pnpm" (builtins.functionArgs mkPnpmCliFactory)) {
            pnpm = pinnedPnpm;
          }
        );
        pureEvalFixture = mkPnpmCli {
          name = "mk-pnpm-cli-pure-eval-fixture";
          binaryName = "mk-pnpm-cli-pure-eval-fixture";
          entry = "app/src/mod.ts";
          packageDir = "app";
          workspaceRoot = ./fixture-workspace;
          workspaceSources = {
            "repos/effect-utils" = effectUtilsSource;
          };
          depsBuilds = {
            "." = {
              hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
            };
            "repos/effect-utils" = {
              hash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
            };
          };
          smokeTestArgs = [ ];
        };
      in
      {
        packages = {
          genie = effectUtilsPackages.genie;
          megarepo = effectUtilsPackages.megarepo;
          oxlint-npm = effectUtilsPackages.oxlint-npm;
          default = effectUtilsPackages.megarepo;
        };
        checks.pure-eval-external-install-roots = pkgs.runCommand "mk-pnpm-cli-pure-eval" { } ''
          actual='${builtins.toJSON (map (root: root.installDir) pureEvalFixture.passthru.installRoots)}'
          expected='[".","repos/effect-utils"]'
          if [ "$actual" != "$expected" ]; then
            echo "unexpected install roots: $actual" >&2
            exit 1
          fi
          printf '%s' "$actual" > "$out"
        '';
      }
    );
}
