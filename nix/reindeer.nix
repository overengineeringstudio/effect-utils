{ pkgs }:
# Upstream failure: https://hydra.nixos.org/build/352528529
# Remove once nixpkgs Reindeer declares its required system libraries.
pkgs.reindeer.overrideAttrs (old: {
  buildInputs = (old.buildInputs or [ ]) ++ [
    pkgs.libgit2
    pkgs.sqlite
  ];
})
