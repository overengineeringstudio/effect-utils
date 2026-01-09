# Standard Nix flake entry point for `nix build/develop` commands.
# See nix/flake-outputs.nix for why we also need .devenv.flake.nix.
{
  description = "Genie CLI for generating config files from .genie.ts templates";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = inputs: import ./nix/flake-outputs.nix inputs;
}
