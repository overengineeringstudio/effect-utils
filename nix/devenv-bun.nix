{ pkgs }:
# Remove when locked nixpkgs has bun >= 1.4.3.
# https://github.com/oven-sh/bun/pull/44581
# https://github.com/NixOS/nixpkgs/pull/577354
# Private to this repository's devenv shell; never import from published packages.
assert pkgs.lib.assertMsg (pkgs.lib.versionOlder pkgs.bun.version "1.4.3")
  "Remove nix/devenv-bun.nix: locked nixpkgs Bun already contains the spawnSync GC fix";
pkgs.bun.overrideAttrs (
  finalAttrs: previousAttrs:
  let
    # From nixpkgs PR #577354 (0d765791b09356dd5b356559c1b67c1600ca3c5b),
    # checked against the official bun-v1.4.4 SHASUMS256.txt release asset.
    sources = {
      aarch64-darwin = pkgs.fetchurl {
        url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-darwin-aarch64.zip";
        hash = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
      };
      aarch64-linux = pkgs.fetchurl {
        url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
        hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
      };
      x86_64-linux = pkgs.fetchurl {
        url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64-baseline.zip";
        hash = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
      };
    };
  in
  {
    version = "1.4.4";
    src = sources.${pkgs.stdenv.hostPlatform.system};
    passthru = previousAttrs.passthru // {
      inherit sources;
    };
  }
)
