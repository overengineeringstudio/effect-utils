# Keep nixpkgs' native build and sandbox defaults; pin the upstream release that
# replaces per-bind mountinfo reparsing with recursive mount_setattr (PR #756).
{ pkgs }:
pkgs.bubblewrap.overrideAttrs (_: rec {
  version = "0.13.0";
  src = pkgs.fetchurl {
    url = "https://github.com/containers/bubblewrap/releases/download/v${version}/bubblewrap-${version}.tar.xz";
    hash = "sha256-RzQjdHPA5daV5OkDSjTkOy2/UWRlW9E/pZrjdrK3p2U=";
  };
})
