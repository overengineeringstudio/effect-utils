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

      mkPatchedPlaywrightDriver = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          upstreamDriver = playwright-web-flake.packages.${system}.playwright-driver;
          browsersJson = upstreamDriver.passthru.browsersJSON;
          components =
            upstreamDriver.passthru.components
            // lib.optionalAttrs (system != "aarch64-linux") {
              /**
               * TODO: Drop this local override once upstream switches its generated
               * Chromium fetchers to the working Chrome for Testing URLs.
               * References:
               * - microsoft/playwright#39586
               * - microsoft/playwright#38967
               * - microsoft/playwright#39574
               * - pietdevries94/playwright-web-flake#20
               */
              chromium = pkgs.callPackage ./playwright-driver/chromium-cft.nix {
                inherit system;
                browserVersion = browsersJson.chromium.browserVersion;
                fontconfig_file = pkgs.makeFontsConf {
                  fontDirectories = [ ];
                };
              };
              chromium-headless-shell =
                pkgs.callPackage ./playwright-driver/chromium-headless-shell-cft.nix {
                  inherit system;
                  browserVersion = browsersJson.chromium.browserVersion;
                };
            };
          browsers = pkgs.linkFarm "playwright-browsers" (
            lib.listToAttrs (
              map
                (
                  name:
                  let
                    revName = if name == "chromium-headless-shell" then "chromium" else name;
                    value = browsersJson.${revName};
                  in
                  lib.nameValuePair
                    "${lib.replaceStrings [ "-" ] [ "_" ] name}-${value.revision}"
                    components.${name}
                )
                [
                  "chromium"
                  "chromium-headless-shell"
                  "firefox"
                  "webkit"
                  "ffmpeg"
                ]
            )
          );
        in
        upstreamDriver.overrideAttrs (old: {
          passthru = old.passthru // {
            inherit browsers;
            browsers-chromium = browsers;
          };
        });

      mkPlaywrightWrapper = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          playwrightDriver = mkPatchedPlaywrightDriver system;
        in
        pkgs.writeShellScriptBin "playwright" ''
          export PLAYWRIGHT_BROWSERS_PATH="${playwrightDriver.browsers}"
          exec "''${PLAYWRIGHT_BIN:-$PWD/node_modules/.bin/playwright}" "$@"
        '';
    in
    {
      packages = forAllSystems (system: {
        playwright-driver = mkPatchedPlaywrightDriver system;
        playwright = mkPlaywrightWrapper system;
        default = mkPlaywrightWrapper system;
      });

      devenvModules.default = { pkgs, ... }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          playwrightDriver = mkPatchedPlaywrightDriver system;
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
