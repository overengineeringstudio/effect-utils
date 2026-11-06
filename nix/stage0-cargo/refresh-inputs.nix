let
  flake = builtins.getFlake ("git+file://" + toString ../..);
  system = builtins.currentSystem;
  pkgs = import flake.inputs.nixpkgs { inherit system; };
in
pkgs.linkFarm "stage0-cargo-refresh-inputs" [
  {
    name = "cargo";
    path = pkgs.cargo;
  }
  {
    name = "rustc";
    path = pkgs.rustc;
  }
  {
    name = "vendor";
    path = pkgs.rustPlatform.importCargoLock { lockFile = ../../rust/Cargo.lock; };
  }
  {
    name = "genie";
    path = flake.packages.${system}.genie;
  }
]
