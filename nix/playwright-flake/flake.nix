{
  description = "Playwright for Nix - browser drivers and devenv module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    playwright-web-flake.url = "github:pietdevries94/playwright-web-flake";
    playwright-web-flake.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, playwright-web-flake, ... }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: lib.genAttrs systems (system: f system);

      mkPlaywrightWrapper = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          playwrightDriver = playwright-web-flake.packages.${system}.playwright-driver;
        in
        pkgs.writeShellScriptBin "playwright" ''
          export PLAYWRIGHT_BROWSERS_PATH="${playwrightDriver.browsers}"
          exec "''${PLAYWRIGHT_BIN:-$PWD/node_modules/.bin/playwright}" "$@"
        '';
    in
    {
      packages = forAllSystems (system: {
        playwright-driver = playwright-web-flake.packages.${system}.playwright-driver;
        playwright = mkPlaywrightWrapper system;
        default = mkPlaywrightWrapper system;
      });

      devenvModules.default = { pkgs, ... }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          playwrightDriver = playwright-web-flake.packages.${system}.playwright-driver;
          playwrightWrapper = mkPlaywrightWrapper system;
        in
        {
          packages = [ playwrightWrapper ];

          env = {
            PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
          };
        };
    };
}
