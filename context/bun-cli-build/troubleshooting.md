# Bun CLI Build Troubleshooting

## Sub-flake purity boundaries

Sub-flakes are evaluated as their own purity boundaries:

- `nix build .#default` uses a git+file snapshot, so only committed files are visible.
- `nix build path:.#default` includes uncommitted files, but pure evaluation
  forbids `../` imports outside the sub-flake root.

Structural fix: make the sub-flake self-contained and import shared helpers via
explicit inputs rather than `../` paths. Example pattern (for `scripts/`):

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
  nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
  flake-utils.url = "github:numtide/flake-utils";
  effect-utils = {
    url = "path:.."; # workspace root
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
    inputs.flake-utils.follows = "flake-utils";
  };
};

outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, effect-utils, ... }:
  flake-utils.lib.eachDefaultSystem (system:
    let
      pkgs = import nixpkgs { inherit system; };
      pkgsUnstable = import nixpkgsUnstable { inherit system; };
      mkBunCli = effect-utils.lib.mkBunCli { inherit pkgs pkgsUnstable; };
    in
    {
      packages.default = import ./nix/build.nix {
        inherit pkgs pkgsUnstable mkBunCli;
        src = effect-utils;
      };
    });
```

## Stale bunDeps snapshots with local file deps

When a package depends on local file deps (`file:../...`), bunDeps snapshots can
lag behind if `bunDepsHash` is not refreshed. Symptoms:

- `tsc` fails inside `node_modules` because a new file is referenced but missing
  in the snapshot (for example `TS2307: Cannot find module './install.ts'`).

Fixes:

- Refresh `bunDepsHash` after adding new files in local deps.
- For local iteration, enable the `dirty` overlay in `mkBunCli` so local deps
  override the bunDeps snapshot.
