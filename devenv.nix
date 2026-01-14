{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  pkgsStable = import inputs.nixpkgs { inherit system; };
  pkgsUnstable = import inputs.nixpkgsUnstable { inherit system; };
  # Build CLIs against the same nixpkgs set as the flake outputs.
  mkBunCli = import ./nix/mk-bun-cli.nix { pkgs = pkgsStable; inherit pkgsUnstable; };
  # Keep devenv outputs aligned with flake outputs so mono nix status is accurate.
  gitRev = "unknown";
  workspaceSrc = ./.;
  playwrightDriver = inputs.playwright-web-flake.packages.${system}.playwright-driver;
  genie = mkBunCli {
    name = "genie";
    entry = "packages/@overeng/genie/src/build/mod.ts";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = workspaceSrc;
    typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
    bunDepsHash = "sha256-xzYr5vBSxy85kn0pitidwiqY6BCZtUzseJlWtmr2NqY=";
    inherit gitRev;
  };
  dotdot = mkBunCli {
    name = "dotdot";
    entry = "packages/@overeng/dotdot/src/cli.ts";
    binaryName = "dotdot";
    packageDir = "packages/@overeng/dotdot";
    workspaceRoot = workspaceSrc;
    typecheckTsconfig = "packages/@overeng/dotdot/tsconfig.json";
    bunDepsHash = "sha256-0HfezPxkSbXI4+0sLjhZ4u44j7nIp/25zRXRXRxPaSM=";
    inherit gitRev;
  };
  mono = import ./scripts/nix/build.nix {
    pkgs = pkgsStable;
    inherit pkgsUnstable mkBunCli gitRev;
    src = workspaceSrc;
  };
  cliBuildStamp = import ./nix/cli-build-stamp.nix { inherit pkgs; };
in
{
  packages = [
    pkgs.pnpm
    pkgsUnstable.nodejs_24
    pkgsUnstable.bun
    pkgsUnstable.typescript
    pkgsUnstable.oxlint
    pkgsUnstable.oxfmt
    genie
    dotdot
    mono
    cliBuildStamp.package
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = playwrightDriver.browsers;
  };

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    ${cliBuildStamp.shellHook}
  '';
}
