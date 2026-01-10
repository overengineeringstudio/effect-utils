# Shared Nix builder for Bun-compiled TypeScript CLIs.
{ pkgs, pkgsUnstable, src }:

{
  name,
  entry,
  binaryName ? name,
  packageJsonPath,
  bunDepsHash,
  gitRev ? "unknown",
  typecheck ? true,
  typecheckTsconfig ? "${builtins.dirOf packageJsonPath}/tsconfig.json",
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
      set +e
      bun install 2>&1 | tee bun-install.log
      status=''${PIPESTATUS[0]}
      set -e

      if [ "$status" -ne 0 ]; then
        echo "bun install failed with exit code $status" >&2
        echo "=== bun install log (tail) ===" >&2
        tail -n 200 bun-install.log || true
        echo "=== bun install log (grep error) ===" >&2
        grep -nE "error|ERR|failed|Failure" bun-install.log || true
        echo "=== bun install verbose (retry) ===" >&2
        set +e
        bun install --verbose --no-progress --no-summary 2>&1 | tee bun-install-verbose.log
        vstatus=''${PIPESTATUS[0]}
        set -e
        echo "=== bun install verbose log (tail) ===" >&2
        tail -n 200 bun-install-verbose.log || true
        echo "=== bun install verbose log (grep error) ===" >&2
        grep -nE "error|ERR|failed|Failure" bun-install-verbose.log || true
        exit "$status"
      fi
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
  ] ++ pkgs.lib.optionals typecheck [
    pkgsUnstable.typescript-go
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

    ${pkgs.lib.optionalString typecheck ''
      if [ ! -f "${typecheckTsconfig}" ]; then
        echo "TypeScript config not found: ${typecheckTsconfig}" >&2
        exit 1
      fi

      echo "Running TypeScript typecheck (tsgo)..."
      tsgo --project "${typecheckTsconfig}" --noEmit
    ''}

    build_output="$TMPDIR/${binaryName}"
    substituteInPlace "${entry}" \
      --replace "const buildVersion = '__CLI_VERSION__'" "const buildVersion = '${fullVersion}'"

    bun build ${entry} \
      --compile \
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
