{ pkgs, inputs, ... }:
let
  playwrightDriver = inputs.playwright-web-flake.packages.${pkgs.system}.playwright-driver;
  genie = inputs.genie.packages.${pkgs.system}.default;
  # Dev shell goal: expose local CLIs fast and without heavyweight Nix builds.
  # Tradeoff: wrappers depend on repo checkout + bun at runtime, not reproducible binaries.
  pnpmCompose = pkgs.writeShellScriptBin "pnpm-compose" ''
    exec ${pkgs.bun}/bin/bun "$WORKSPACE_ROOT/packages/@overeng/pnpm-compose/src/cli.ts" "$@"
  '';
  bunCompose = pkgs.writeShellScriptBin "bun-compose" ''
    exec ${pkgs.bun}/bin/bun "$WORKSPACE_ROOT/packages/@overeng/bun-compose/src/cli.ts" "$@"
  '';
in
{
  # Apply pnpm guard overlay from local pnpm-compose package (fetched via devenv.yaml with flake: false)
  # See pnpm-compose README for design rationale on this approach
  overlays = [
    (import "${inputs.pnpm-compose}/nix/overlay.nix")
  ];

  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    pkgs.oxlint
    pkgs.oxfmt
    genie
    # Lightweight wrappers keep dev shell fast while exposing local CLIs.
    pnpmCompose
    bunCompose
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
  };

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/scripts/bin:$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
