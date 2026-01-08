# Nix derivation that builds pnpm-compose CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src }:

let
  # Filter source to only include files that affect dependency resolution
  # This prevents bunDeps hash changes when editing source code
  depFiles = pkgs.lib.fileset.toSource {
    root = src;
    fileset = pkgs.lib.fileset.unions [
      (src + "/package.json")
      (src + "/bun.lock")
      (src + "/patches")
      # Include all package.json files from packages/
      (pkgs.lib.fileset.fileFilter (file: file.name == "package.json") (src + "/packages"))
    ];
  };

  # Fixed-output derivation to fetch bun dependencies
  # Uses network access but produces deterministic output verified by hash
  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    name = "pnpm-compose-bun-deps";

    src = depFiles;

    nativeBuildInputs = [ pkgsUnstable.bun pkgs.cacert ];

    # Fixed-output derivation - allows network, verified by hash
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    # Update when bun.lock changes. Run: nix build .#rc -L
    # then copy the "got: sha256-..." value
    outputHash = "sha256-q2keLYO6Uqe/juPq+pDbIdzpBcAn4sZda4szh3TsAe8=";

    buildPhase = ''
      export HOME=$TMPDIR
      bun install
    '';

    installPhase = ''
      mkdir -p $out
      # Remove workspace symlinks (they point to local packages not in node_modules)
      find node_modules -type l ! -exec test -e {} \; -delete 2>/dev/null || true
      cp -r node_modules $out/
    '';

    # Disable fixup phase (patching shebangs would add store references to FOD output)
    dontFixup = true;
    # Disable symlink check since we intentionally remove workspace symlinks
    dontCheckForBrokenSymlinks = true;
  };
in
pkgs.stdenv.mkDerivation {
  name = "pnpm-compose";

  inherit src;

  nativeBuildInputs = [
    pkgsUnstable.bun
    pkgs.cacert
  ];

  # Don't strip the binary - it corrupts bun's embedded bytecode
  dontStrip = true;
  dontPatchELF = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild

    # Link pre-fetched deps
    ln -s ${bunDeps}/node_modules node_modules

    # Set up writable directories for Nix sandbox
    export HOME="$TMPDIR/home"
    export BUN_INSTALL="$PWD/.bun"
    export BUN_TMPDIR="$PWD/.bun-tmp"
    mkdir -p "$HOME" "$BUN_INSTALL" "$BUN_TMPDIR"

    build_output="$TMPDIR/pnpm-compose"

    # Build native binary
    bun build packages/@overeng/pnpm-compose/src/cli.ts \
      --compile \
      --outfile="$build_output"

    if [ ! -s "$build_output" ]; then
      echo "bun build produced an empty pnpm-compose binary" >&2
      exit 1
    fi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    install -m 755 "$TMPDIR/pnpm-compose" $out/bin/pnpm-compose

    runHook postInstall
  '';
}
