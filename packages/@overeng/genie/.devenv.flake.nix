# devenv CLI entry point - devenv looks for this file instead of flake.nix.
# See nix/flake-outputs.nix for why this file is needed.
#
# Consumers reference this via devenv.yaml (without `flake: false`):
#   genie:
#     url: path:./submodules/effect-utils/packages/@overeng/genie
{
  description = "Genie CLI for generating config files from .genie.ts templates";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = inputs: import ./nix/flake-outputs.nix inputs;
}
