{
  description = "Playwright for Nix - browser drivers and devenv module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    playwright-web-flake.url = "github:pietdevries94/playwright-web-flake";
    playwright-web-flake.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, playwright-web-flake, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

      # Create playwright wrapper for a given system
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
      # Re-export playwright packages for direct flake usage
      packages = forAllSystems (system: {
        playwright-driver = playwright-web-flake.packages.${system}.playwright-driver;
        playwright = mkPlaywrightWrapper system;
        default = mkPlaywrightWrapper system;
      });

      # Devenv module - completely self-contained
      # Usage:
      #   imports = [ inputs.playwright.devenvModules.default ];
      #
      # Provides:
      #   - `playwright` command in PATH (wrapper that uses node_modules/.bin/playwright)
      #   - PLAYWRIGHT_BROWSERS_PATH env var pointing to nix-provided browsers
      #
      # The wrapper can be overridden via PLAYWRIGHT_BIN env var if needed.
      devenvModules.default = { pkgs, ... }:
        let
          playwrightDriver = playwright-web-flake.packages.${pkgs.system}.playwright-driver;
          playwrightWrapper = mkPlaywrightWrapper pkgs.system;
        in
        {
          packages = [ playwrightWrapper ];

          env = {
            PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
          };
        };
    };
}
