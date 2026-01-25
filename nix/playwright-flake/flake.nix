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
    in
    {
      # Re-export playwright packages for direct flake usage
      packages = forAllSystems (system: {
        playwright-driver = playwright-web-flake.packages.${system}.playwright-driver;
        default = playwright-web-flake.packages.${system}.playwright-driver;
      });

      # Devenv module - completely self-contained
      # Usage:
      #   imports = [ inputs.playwright.devenvModules.default ];
      devenvModules.default = { pkgs, ... }:
        let
          playwrightDriver = playwright-web-flake.packages.${pkgs.system}.playwright-driver;
        in
        {
          env = {
            PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
          };

          enterShell = ''
            # Ensure playwright CLI from node_modules is available
            export PATH="$PWD/node_modules/.bin:$PATH"
          '';
        };
    };
}
