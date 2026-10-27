{ pkgs }:

# Reuse the Wrangler derivation from the consumer's locked nixpkgs rather than
# introducing another npm lockfile and platform-specific native dependency tree.
# effect-utils' nixpkgs pin currently supplies Wrangler 4.129.0, including its
# Node wrapper, CA certificates, and native dependencies on Linux and Darwin.
pkgs.wrangler
