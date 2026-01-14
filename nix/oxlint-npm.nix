# Package npm oxlint with NAPI bindings to enable JavaScript plugin support.
#
# The Nix-native oxlint binary (pkgs.oxlint) is compiled from Rust and cannot
# execute JS plugins. The npm version uses NAPI bindings to run Rust code from
# a JS runtime (Bun), enabling jsPlugins support.
#
# Usage: import ./oxlint-npm.nix { inherit pkgs bun; }
#
# =============================================================================
# Updating to a new version
# =============================================================================
#
# 1. Check latest version:
#    npm view oxlint version
#
# 2. Update `version` below to the new version number
#
# 3. Calculate new hashes (run in /tmp to avoid direnv issues):
#    cd /tmp
#    VERSION=1.39.0  # <-- set to new version
#
#    # Main package
#    nix hash convert --to sri --hash-algo sha256 \
#      $(nix-prefetch-url https://registry.npmjs.org/oxlint/-/oxlint-$VERSION.tgz)
#
#    # Platform binaries
#    for pkg in darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu; do
#      echo "$pkg:"
#      nix hash convert --to sri --hash-algo sha256 \
#        $(nix-prefetch-url https://registry.npmjs.org/@oxlint/$pkg/-/$pkg-$VERSION.tgz)
#    done
#
# 4. Update hashes in this file (mainPackage.hash and platformPackages.*.hash)
#
# 5. Reload devenv and verify:
#    direnv reload
#    oxlint --version
#    mono lint  # should show "WARNING: JS plugins are experimental..."
#
# =============================================================================
{ pkgs, bun }:
let
  version = "1.39.0";

  # Platform-specific package mapping
  platformPackages = {
    "aarch64-darwin" = {
      name = "@oxlint/darwin-arm64";
      hash = "sha256-pYvXAL2521WpQbgNSv+pQuQaHKO4XOPGJdN8vIEWIBs=";
    };
    "x86_64-darwin" = {
      name = "@oxlint/darwin-x64";
      hash = "sha256-InilX7tJW1pBEt1uh1gfEEZM5oUp8LFRyH075o+70YQ=";
    };
    "x86_64-linux" = {
      name = "@oxlint/linux-x64-gnu";
      hash = "sha256-2lI9OZMPnB3Le9lWJQOZgmXhPy6Mkxz26uSxMn3oKQQ=";
    };
    "aarch64-linux" = {
      name = "@oxlint/linux-arm64-gnu";
      hash = "sha256-0hJz/Oo7yBJDmW+DhTrLjdHZiq2XQHXEIF9A+/LdwqY=";
    };
  };

  system = pkgs.stdenv.hostPlatform.system;
  platformPkg = platformPackages.${system} or (throw "Unsupported platform: ${system}");

  # Fetch the main oxlint npm package
  mainPackage = pkgs.fetchurl {
    url = "https://registry.npmjs.org/oxlint/-/oxlint-${version}.tgz";
    hash = "sha256-oCJQYGG+MGuBlwJ07b7hJKku0/xNQVXtbLpfs5xGeso=";
  };

  # Fetch the platform-specific binary package
  # npm scoped packages use a different URL pattern
  binaryPackage = pkgs.fetchurl {
    url = "https://registry.npmjs.org/${platformPkg.name}/-/${builtins.replaceStrings ["@oxlint/"] [""] platformPkg.name}-${version}.tgz";
    hash = platformPkg.hash;
  };

in pkgs.stdenv.mkDerivation {
  pname = "oxlint-npm";
  inherit version;

  dontUnpack = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  buildPhase = ''
    runHook preBuild

    # Create node_modules structure
    mkdir -p $out/lib/node_modules/oxlint
    mkdir -p $out/lib/node_modules/${platformPkg.name}
    mkdir -p $out/bin

    # Extract main oxlint package
    tar -xzf ${mainPackage} -C $out/lib/node_modules/oxlint --strip-components=1

    # Extract platform-specific binary package
    tar -xzf ${binaryPackage} -C $out/lib/node_modules/${platformPkg.name} --strip-components=1

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Create wrapper script that sets up NODE_PATH (Bun uses NODE_PATH for module resolution)
    makeWrapper ${bun}/bin/bun $out/bin/oxlint \
      --add-flags "$out/lib/node_modules/oxlint/bin/oxlint" \
      --set NODE_PATH "$out/lib/node_modules"

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "npm oxlint with NAPI bindings for JavaScript plugin support";
    homepage = "https://oxc.rs/docs/guide/usage/linter.html";
    license = licenses.mit;
    mainProgram = "oxlint";
    platforms = builtins.attrNames platformPackages;
  };
}
