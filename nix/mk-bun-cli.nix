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
  # workspaceDeps entries are inlined into node_modules for bun build.
  # If you override depFiles, include full workspace dirs (not just package.json).
  workspaceDeps ? [],
  depFiles ? (
    if builtins.typeOf src == "path"
    then pkgs.lib.fileset.toSource {
      root = src;
      fileset = pkgs.lib.fileset.unions (
        [
          (src + "/package.json")
          (src + "/bun.lock")
          (src + "/patches")
          # If workspaceDeps are used, include full workspace dirs so bun can
          # install their deps and we can copy node_modules into the build.
          (pkgs.lib.fileset.fileFilter (file: file.name == "package.json") (src + "/packages"))
        ]
        ++ (
          if builtins.length workspaceDeps == 0
          then []
          else [
            (pkgs.lib.fileset.unions (
              map (dep: (src + "/${dep.path}")) workspaceDeps
            ))
          ]
        )
      );
    }
    # Store paths from flake inputs are string-like; fileset rejects them.
    # Fall back to the full source to keep remote inputs usable.
    else src
  )
}:

let
  # Fail fast if a workspace dependency is missing its package.json.
  workspaceDepsChecked = map (dep:
    assert pkgs.lib.assertMsg
      (builtins.pathExists (builtins.toPath "${src}/${dep.path}/package.json"))
      "mk-bun-cli: workspaceDeps entry ${dep.name} missing ${dep.path}/package.json";
    dep
  ) workspaceDeps;

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

      # Capture workspace package deps so the CLI build can resolve them in Nix.
      ${pkgs.lib.concatMapStringsSep "\n" (dep: ''
        bun install --cwd "${dep.path}"
      '') workspaceDepsChecked}
    '';

    installPhase = ''
      mkdir -p $out
      # Remove workspace symlinks (they point to local packages not in node_modules)
      find node_modules -type l ! -exec test -e {} \; -delete 2>/dev/null || true
      cp -r node_modules $out/
      # Persist workspace node_modules separately for later injection.
      ${pkgs.lib.concatMapStringsSep "\n" (dep: ''
        if [ -d "${dep.path}/node_modules" ]; then
          mkdir -p "$out/workspace-node-modules/${dep.name}/node_modules"
          cp -R "${dep.path}/node_modules/." "$out/workspace-node-modules/${dep.name}/node_modules/"
          find "$out/workspace-node-modules/${dep.name}/node_modules" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
        fi
      '') workspaceDepsChecked}
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

    if [ ${toString (builtins.length workspaceDeps)} -gt 0 ]; then
      # Copy so we can inline workspace deps into node_modules.
      cp -R ${bunDeps}/node_modules ./node_modules
      chmod -R u+w ./node_modules
    else
      ln -s ${bunDeps}/node_modules node_modules
    fi

    export HOME="$TMPDIR/home"
    export BUN_INSTALL="$PWD/.bun"
    export BUN_TMPDIR="$PWD/.bun-tmp"
    mkdir -p "$HOME" "$BUN_INSTALL" "$BUN_TMPDIR"

    # Materialize workspace deps because bunDeps removes workspace symlinks.
    ${pkgs.lib.concatMapStringsSep "\n" (dep: ''
      parent_dir="$(dirname "node_modules/${dep.name}")"
      if [ -L "$parent_dir" ]; then
        rm -f "$parent_dir"
      fi
      mkdir -p "$parent_dir"
      rm -rf "node_modules/${dep.name}"
      cp -R "${src}/${dep.path}/." "node_modules/${dep.name}/"
      chmod -R u+w "node_modules/${dep.name}"
      # Inject workspace dependency node_modules captured in bunDeps.
      if [ -d "${bunDeps}/workspace-node-modules/${dep.name}/node_modules" ]; then
        mkdir -p "node_modules/${dep.name}/node_modules"
        cp -R "${bunDeps}/workspace-node-modules/${dep.name}/node_modules/." "node_modules/${dep.name}/node_modules/"
        chmod -R u+w "node_modules/${dep.name}/node_modules"
      fi
    '') workspaceDepsChecked}

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
