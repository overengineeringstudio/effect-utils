{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  pkgsStable = import inputs.nixpkgs { inherit system; };
  pkgsUnstable = import inputs.nixpkgsUnstable { inherit system; };
  # Build CLIs against the same nixpkgs set as the flake outputs.
  mkBunCli = import ./nix/mk-bun-cli.nix { pkgs = pkgsStable; inherit pkgsUnstable; };
  # Keep devenv outputs aligned with flake outputs so mono nix status is accurate.
  # TODO use proper git rev
  gitRev = "unknown";
  workspaceSrc = ./.;
  playwrightDriver = inputs.playwright-web-flake.packages.${system}.playwright-driver;
  genie = mkBunCli {
    name = "genie";
    entry = "packages/@overeng/genie/src/build/mod.ts";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = workspaceSrc;
    typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
    bunDepsHash = "sha256-WKLVXT7HgS9RUZJ1apuYgzWJJuwUou49R417iK2gQCc=";
    inherit gitRev;
  };
  dotdot = mkBunCli {
    name = "dotdot";
    entry = "packages/@overeng/dotdot/src/cli.ts";
    binaryName = "dotdot";
    packageDir = "packages/@overeng/dotdot";
    workspaceRoot = workspaceSrc;
    typecheckTsconfig = "packages/@overeng/dotdot/tsconfig.json";
    smokeTestCwd = "workspace";
    smokeTestSetup = ''
      printf '%s\n' '{"repos":{}}' > "$smoke_test_cwd/dotdot-root.json"
    '';
    bunDepsHash = "sha256-x4/xady1TuC1oYtYh/I1YDm7MBb60ld2vPLbZiBUrNQ=";
    inherit gitRev;
  };
  mono = import ./scripts/nix/build.nix {
    pkgs = pkgsStable;
    inherit pkgsUnstable mkBunCli gitRev;
    src = workspaceSrc;
  };
  cliBuildStamp = import ./nix/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings to enable JavaScript plugin support
  oxlintNpm = import ./nix/oxlint-npm.nix {
    inherit pkgs;
    bun = pkgsUnstable.bun;
  };
in
{
  packages = [
    pkgs.pnpm
    pkgsUnstable.nodejs_24
    pkgsUnstable.bun
    pkgsUnstable.typescript
    oxlintNpm
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
