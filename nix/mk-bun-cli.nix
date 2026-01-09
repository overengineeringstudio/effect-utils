# Shared Nix builder for Bun-compiled TypeScript CLIs.
{ pkgs, pkgsUnstable, src }:

{
  name,
  entry,
  binaryName ? name,
  packageJsonPath,
  bunDepsHash,
  gitRev ? "unknown",
  depFiles ? pkgs.lib.fileset.toSource {
    root = src;
    fileset = pkgs.lib.fileset.unions [
      (src + "/package.json")
      (src + "/bun.lock")
      (src + "/patches")
      (pkgs.lib.fileset.fileFilter (file: file.name == "package.json") (src + "/packages"))
    ];
  }
}:

let
  packageJson = builtins.fromJSON (builtins.readFile (src + "/${packageJsonPath}"));
  baseVersion = packageJson.version or "0.0.0";
  fullVersion = if gitRev == "unknown" then baseVersion else "${baseVersion}+${gitRev}";

  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    name = "${name}-bun-deps";

    src = depFiles;

    nativeBuildInputs = [ pkgsUnstable.bun pkgs.cacert ];

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = bunDepsHash;

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

    dontFixup = true;
    dontCheckForBrokenSymlinks = true;
  };
in
pkgs.stdenv.mkDerivation {
  inherit name src;

  nativeBuildInputs = [
    pkgsUnstable.bun
    pkgs.cacert
  ];

  dontStrip = true;
  dontPatchELF = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild

    ln -s ${bunDeps}/node_modules node_modules

    export HOME="$TMPDIR/home"
    export BUN_INSTALL="$PWD/.bun"
    export BUN_TMPDIR="$PWD/.bun-tmp"
    mkdir -p "$HOME" "$BUN_INSTALL" "$BUN_TMPDIR"

    build_output="$TMPDIR/${binaryName}"
    version_define=${pkgs.lib.escapeShellArg fullVersion}

    bun build ${entry} \
      --compile \
      --define __CLI_VERSION__="$version_define" \
      --outfile="$build_output"

    if [ ! -s "$build_output" ]; then
      echo "bun build produced an empty ${binaryName} binary" >&2
      exit 1
    fi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    install -m 755 "$TMPDIR/${binaryName}" $out/bin/${binaryName}

    runHook postInstall
  '';
}
