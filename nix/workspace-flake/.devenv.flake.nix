{
  # Devenv requires this file to evaluate to an attrset, even when we only need
  # a tiny workspace flake for pinning nixpkgs. Keeping it explicit avoids
  # devenv update failures without pulling in extra logic.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, ... }: { };
}
