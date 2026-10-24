{
  description = "Playwright for Nix - browser drivers and devenv module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    playwright-web-flake.url = "github:pietdevries94/playwright-web-flake";
    playwright-web-flake.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    { nixpkgs, playwright-web-flake, ... }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f system);

      mkPlaywrightDriver =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          upstream = playwright-web-flake.packages.${system}.playwright-driver;
          components = upstream.components // {
            chromium =
              if system == "aarch64-linux" then
                upstream.components.chromium.overrideAttrs (old: {
                  # Upstream installs the arm64 archive under chrome-linux-arm64,
                  # but its Vulkan fixup still uses the x86_64 directory.
                  postFixup =
                    lib.replaceStrings [ "$out/chrome-linux64" ] [ "$out/chrome-linux-arm64" ]
                      old.postFixup;
                })
              else
                pkgs.callPackage ./chromium-darwin.nix {
                  chromium = upstream.components.chromium;
                };
          };
          selectBrowsers = lib.makeOverridable (
            {
              withChromium ? true,
              withFirefox ? true,
              withWebkit ? true,
              withFfmpeg ? true,
              withChromiumHeadlessShell ? true,
              fontconfig_file ? null,
            }:
            pkgs.linkFarm "playwright-browsers" (
              map
                (
                  name:
                  let
                    revName = if name == "chromium-headless-shell" then "chromium" else name;
                    revision = upstream.browsersJSON.${revName}.revision;
                  in
                  {
                    name = "${lib.replaceStrings [ "-" ] [ "_" ] name}-${revision}";
                    path = components.${name};
                  }
                )
                (
                  lib.optional withChromium "chromium"
                  ++ lib.optional withChromiumHeadlessShell "chromium-headless-shell"
                  ++ lib.optional withFirefox "firefox"
                  ++ lib.optional withWebkit "webkit"
                  ++ lib.optional withFfmpeg "ffmpeg"
                )
            )
          );
        in
        if !pkgs.stdenv.hostPlatform.isDarwin && system != "aarch64-linux" then
          upstream
        else
          upstream.overrideAttrs {
            passthru = {
              inherit (upstream) browsersJSON;
              inherit components selectBrowsers;
              browsers = selectBrowsers { };
              browsers-chromium = selectBrowsers {
                withFirefox = false;
                withWebkit = false;
                withChromiumHeadlessShell = false;
              };
            };
          };

      mkPlaywrightWrapper =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          playwrightDriver = mkPlaywrightDriver system;
          playwrightBrowsers = playwrightDriver.browsers.override { withWebkit = false; };
        in
        pkgs.writeShellScriptBin "playwright" ''
          export PLAYWRIGHT_BROWSERS_PATH="${playwrightBrowsers}"
          exec "''${PLAYWRIGHT_BIN:-$PWD/node_modules/.bin/playwright}" "$@"
        '';
    in
    {
      packages = forAllSystems (system: {
        playwright-driver = mkPlaywrightDriver system;
        playwright = mkPlaywrightWrapper system;
        default = mkPlaywrightWrapper system;
      });

      devenvModules.default =
        { pkgs, ... }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          playwrightDriver = mkPlaywrightDriver system;
          playwrightBrowsers = playwrightDriver.browsers.override { withWebkit = false; };
          playwrightWrapper = mkPlaywrightWrapper system;
        in
        {
          packages = [ playwrightWrapper ];

          env = {
            PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsers;
          };
        };
    };
}
