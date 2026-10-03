{
  description = "Downstream consumer of retained effect-utils public flake outputs";

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
      in
      {
        packages = {
          genie = effect-utils.packages.${system}.genie;
          oxlint-npm = effect-utils.packages.${system}.oxlint-npm;
          # #1384: applying the lib function downstream must forward its pnpm archives.
          oxlint-npm-from-lib = effect-utils.lib.mkOxlintNpm {
            inherit pkgs;
            bun = pkgs.bun;
          };
        };
      }
    );
}
