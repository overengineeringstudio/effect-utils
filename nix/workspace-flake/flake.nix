{
  # Workspace-wide nixpkgs pin for peer repos.
  #
  # Peer repos can follow `workspace/nixpkgs` to stay aligned on the same
  # nixpkgs revision while remaining self-contained outside the workspace
  # (they fetch this flake from GitHub).
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, ... }: { };
}
