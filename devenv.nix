{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  pkgsUnstable = import inputs.nixpkgsUnstable { inherit system; };
  mkBunCli = import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
  gitRev = "unknown";
  playwrightDriver = inputs.playwright-web-flake.packages.${system}.playwright-driver;
  genie = mkBunCli {
    name = "genie";
    entry = "packages/@overeng/genie/src/build/mod.ts";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = ./.;
    typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
    bunDepsHash = "sha256-xzYr5vBSxy85kn0pitidwiqY6BCZtUzseJlWtmr2NqY=";
    inherit gitRev;
  };
  dotdot = mkBunCli {
    name = "dotdot";
    entry = "packages/@overeng/dotdot/src/cli.ts";
    binaryName = "dotdot";
    packageDir = "packages/@overeng/dotdot";
    workspaceRoot = ./.;
    typecheckTsconfig = "packages/@overeng/dotdot/tsconfig.json";
    bunDepsHash = "sha256-0HfezPxkSbXI4+0sLjhZ4u44j7nIp/25zRXRXRxPaSM=";
    inherit gitRev;
  };
  mono = import ./scripts/nix/build.nix {
    inherit pkgs pkgsUnstable mkBunCli gitRev;
    src = ./.;
  };
  cliBuildStamp = import ./nix/cli-build-stamp.nix { inherit pkgs; };
in
{
  packages = [
    pkgs.pnpm
    pkgsUnstable.nodejs_24
    pkgsUnstable.bun
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
