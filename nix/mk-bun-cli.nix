# Goals:
# - Provide reliable, simple, fast way to build native binaries via Bun from TypeScript source files.
# - Needs to support locally checked out peer repos with local/uncommitted changes (embracing dotdot workspace model)
# - Supports typechecking via tsc (later tsgo once it supports Effect) 
# 
# Dotdot-first Bun CLI builder.
# - Mirrors dotdot's flat workspace model by staging peer repos at workspace root.
# - Supports dotdot "packages" by creating workspace symlinks (like `dotdot link`).
# - Enforces self-contained packages: each install dir must have its own bun.lock.
#
# Mapping to dotdot concepts (see dotdot/docs/concepts.md):
# - sources: peer repos at workspace root (dotdot "repos")
# - installDirs: per-package installs (dotdot "packages")
# - workspaceLinks: root symlinks for packages (dotdot "link")
{ pkgs, pkgsUnstable, src ? null }:

{
  name,
  entry,
  binaryName ? name,
  sources,
  installDirs ? [],
  workspaceLinks ? [],
  packageJsonPath ? null,
  bunDepsHash,
  gitRev ? "unknown",
  typecheck ? true,
  typecheckTool ? "tsc",
  typecheckTsconfig ? null,
  projectRoot ? "",
}:

let
  # Dotdot layout:
  # - sources: peer repos staged at workspace root (name == repo dir)
  # - installDirs: package roots with bun.lock (self-contained installs)
  # - workspaceLinks: dotdot package symlinks (like `dotdot link`)
  toPath = source:
    if builtins.isAttrs source && builtins.hasAttr "outPath" source
    then source.outPath
    else if builtins.isPath source
    then source
    else builtins.toPath source;

  sourcesChecked =
    map (source: source // { path = toPath source.src; }) sources;

  sourceNames = map (source: source.name) sourcesChecked;

  sourcesByName =
    builtins.listToAttrs (map (source: { name = source.name; value = source.path; }) sourcesChecked);

  parseRoot = path:
    let
      parts = pkgs.lib.splitString "/" path;
    in
    {
      sourceName = builtins.head parts;
      subPath = pkgs.lib.concatStringsSep "/" (builtins.tail parts);
    };

  resolveSourcePath = path:
    let
      parsed = parseRoot path;
    in
    assert pkgs.lib.assertMsg
      (builtins.elem parsed.sourceName sourceNames)
      "mk-bun-cli: path '${path}' must start with one of: ${pkgs.lib.concatStringsSep ", " sourceNames}";
    sourcesByName.${parsed.sourceName} + "/${parsed.subPath}";

  installDirsChecked =
    map (dir:
      let
        parsed = parseRoot dir;
      in
      assert pkgs.lib.assertMsg
        (builtins.elem parsed.sourceName sourceNames)
        "mk-bun-cli: installDir '${dir}' must start with one of: ${pkgs.lib.concatStringsSep ", " sourceNames}";
      dir
    ) installDirs;

  installDirPackages =
    map (dir:
      let
        packageJson = builtins.fromJSON (builtins.readFile (resolveSourcePath "${dir}/package.json"));
      in
      {
        name = packageJson.name;
        path = dir;
      }
    ) installDirsChecked;

  installDirDependencies =
    map (dir:
      let
        packageJson = builtins.fromJSON (builtins.readFile (resolveSourcePath "${dir}/package.json"));
        deps = (packageJson.dependencies or {})
          // (packageJson.devDependencies or {})
          // (packageJson.peerDependencies or {});
      in
      {
        path = dir;
        deps = builtins.attrNames deps;
      }
    ) installDirsChecked;

  # Dotdot packages are exposed at workspace root via symlinks that match
  # dotdot's `packages` key (same behavior as `dotdot link`).
  workspaceLinksChecked =
    map (link:
      let
        parsed = parseRoot link.from;
      in
      assert pkgs.lib.assertMsg
        (builtins.elem parsed.sourceName sourceNames)
        "mk-bun-cli: workspaceLinks.from '${link.from}' must start with one of: ${pkgs.lib.concatStringsSep ", " sourceNames}";
      link
    ) workspaceLinks;

  typecheckTsconfigChecked =
    if typecheck
    then
      if typecheckTsconfig != null
      then typecheckTsconfig
      else if projectRoot != ""
      then "${projectRoot}/tsconfig.json"
      else "tsconfig.json"
    else typecheckTsconfig;

  typecheckToolChecked =
    if builtins.elem typecheckTool [ "tsc" "tsgo" ]
    then typecheckTool
    else throw "mk-bun-cli: typecheckTool must be \"tsc\" or \"tsgo\", got: ${typecheckTool}";

  workspaceRoot = pkgs.runCommand "${name}-workspace" {} ''
    mkdir -p "$out"
    ${pkgs.lib.concatMapStringsSep "\n" (source: ''
      mkdir -p "$out/${source.name}"
      cp -R "${source.path}/." "$out/${source.name}/"
    '') sourcesChecked}
  '';

  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    name = "${name}-bun-deps";
    src = workspaceRoot;

    nativeBuildInputs = [ pkgsUnstable.bun pkgs.cacert ];

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = bunDepsHash;

    buildPhase = ''
      export HOME=$TMPDIR
      export NODE_ENV=development
      export NPM_CONFIG_PRODUCTION=false
      export npm_config_production=false
      export NPM_CONFIG_OMIT=
      export npm_config_omit=

      # Dotdot packages are exposed at workspace root via symlinks.
      ${pkgs.lib.concatMapStringsSep "\n" (link: ''
        mkdir -p "$(dirname "${link.to}")"
        rm -rf "${link.to}"
        if [ ! -e "${link.from}" ]; then
          echo "mk-bun-cli: workspaceLinks.from target not found: ${link.from}" >&2
          exit 1
        fi
        ln -s "${link.from}" "${link.to}"
      '') workspaceLinksChecked}

      ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
        if [ ! -f "${dir}/package.json" ]; then
          echo "mk-bun-cli: missing package.json in ${dir}" >&2
          exit 1
        fi
        if [ ! -f "${dir}/bun.lock" ]; then
          echo "mk-bun-cli: missing bun.lock in ${dir} (dotdot expects self-contained packages)" >&2
          exit 1
        fi
        bun install --cwd "${dir}" --frozen-lockfile --linker=hoisted --backend=copyfile
      '') installDirsChecked}
    '';

    installPhase = ''
      mkdir -p "$out"
      ${pkgs.lib.concatMapStringsSep "\n" (source: ''
        if [ -d "${source.name}/node_modules" ]; then
          mkdir -p "$out/${source.name}"
          cp -R "${source.name}/node_modules" "$out/${source.name}/"
        fi
      '') sourcesChecked}
      ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
        if [ -d "${dir}/node_modules" ]; then
          mkdir -p "$out/${dir}"
          cp -R "${dir}/node_modules" "$out/${dir}/"
        fi
      '') installDirsChecked}
      ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
        if [ -d "$out/${dir}/node_modules" ]; then
          find "$out/${dir}/node_modules" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
        fi
      '') installDirsChecked}
    '';

    dontFixup = true;
    dontCheckForBrokenSymlinks = true;
  };

  packageJson =
    if packageJsonPath == null
    then { version = "0.0.0"; }
    else builtins.fromJSON (builtins.readFile (resolveSourcePath packageJsonPath));
  baseVersion = packageJson.version or "0.0.0";
  fullVersion = if gitRev == "unknown" then baseVersion else "${baseVersion}+${gitRev}";
in
pkgs.stdenv.mkDerivation {
  inherit name;
  src = workspaceRoot;

  nativeBuildInputs =
    [
      pkgsUnstable.bun
      pkgs.cacert
    ]
    ++ pkgs.lib.optionals (typecheck && typecheckToolChecked == "tsgo") [
      pkgsUnstable.typescript-go
    ];

  dontStrip = true;
  dontPatchELF = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild

    ${pkgs.lib.concatMapStringsSep "\n" (source: ''
      source_root_node_modules="${bunDeps}/${source.name}/node_modules"
      if [ ! -d "$source_root_node_modules" ] && [ -d "${bunDeps}/node_modules" ]; then
        source_root_node_modules="${bunDeps}/node_modules"
      fi
      if [ -d "$source_root_node_modules" ]; then
        rm -rf "${source.name}/node_modules"
        mkdir -p "${source.name}"
        cp -R "$source_root_node_modules" "${source.name}/"
        chmod -R u+w "${source.name}/node_modules"
      fi
    '') sourcesChecked}

    ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
      source_node_modules="${bunDeps}/${dir}/node_modules"
      if [ ! -d "$source_node_modules" ] && [ -d "${bunDeps}/node_modules" ]; then
        source_node_modules="${bunDeps}/node_modules"
      fi
      if [ -d "$source_node_modules" ]; then
        rm -rf "${dir}/node_modules"
        cp -R "$source_node_modules" "${dir}/node_modules"
        chmod -R u+w "${dir}/node_modules"
      fi
    '') installDirsChecked}

    ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
      if [ -d "${dir}/node_modules" ]; then
        ${pkgs.lib.concatMapStringsSep "\n" (pkg: ''
          pkg_scope="$(dirname "${pkg.name}")"
          if [ "$pkg_scope" != "." ]; then
            mkdir -p "${dir}/node_modules/$pkg_scope"
          fi
          rm -rf "${dir}/node_modules/${pkg.name}"
          ln -s "$PWD/${pkg.path}" "${dir}/node_modules/${pkg.name}"
        '') installDirPackages}
      fi
    '') installDirsChecked}

    ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
      if [ -d "${dir}/node_modules/.bun" ]; then
        types_dir="${dir}/node_modules/@types"
        node_types_link="$types_dir/node"
        if [ ! -e "$node_types_link" ]; then
          node_types_pkg="$(find "$PWD/${dir}/node_modules/.bun" -maxdepth 1 -type d -name '@types+node@*' | sort -V | tail -n 1)"
          if [ -n "$node_types_pkg" ] && [ -d "$node_types_pkg/node_modules/@types/node" ]; then
            mkdir -p "$types_dir"
            ln -s "$node_types_pkg/node_modules/@types/node" "$node_types_link"
          fi
        fi
      fi
    '') installDirsChecked}

    ${pkgs.lib.concatMapStringsSep "\n" (dirSpec: ''
      if [ -d "${dirSpec.path}/node_modules/.bun" ]; then
        ${pkgs.lib.concatMapStringsSep "\n" (dep: ''
          dep_target="${dirSpec.path}/node_modules/${dep}"
          if [ ! -e "$dep_target" ]; then
            dep_source="$(find "$PWD/${dirSpec.path}/node_modules/.bun" -type d -path "*/node_modules/${dep}" | head -n 1)"
            if [ -n "$dep_source" ]; then
              mkdir -p "$(dirname "$dep_target")"
              ln -s "$dep_source" "$dep_target"
            fi
          fi
        '') dirSpec.deps}
      fi
    '') installDirDependencies}

    # Dotdot packages are exposed at workspace root via symlinks.
    ${pkgs.lib.concatMapStringsSep "\n" (link: ''
      mkdir -p "$(dirname "${link.to}")"
      rm -rf "${link.to}"
      if [ ! -e "${link.from}" ]; then
        echo "mk-bun-cli: workspaceLinks.from target not found: ${link.from}" >&2
        exit 1
      fi
      ln -s "${link.from}" "${link.to}"
    '') workspaceLinksChecked}

    ${pkgs.lib.optionalString typecheck ''
      if [ ! -f "${typecheckTsconfigChecked}" ]; then
        echo "TypeScript config not found: ${typecheckTsconfigChecked}" >&2
        exit 1
      fi

      if [ "${typecheckToolChecked}" = "tsgo" ]; then
        # TODO: switch back to tsgo by default once tsgo handles Effect.gen/Tag inference correctly.
        echo "Running TypeScript typecheck (tsgo)..."
        tsgo --project "${typecheckTsconfigChecked}" --noEmit
      else
        echo "Running TypeScript typecheck (tsc)..."
        tsconfig_dir="$(dirname "${typecheckTsconfigChecked}")"
        tsc_entry="$tsconfig_dir/node_modules/typescript/bin/tsc"
        if [ ! -f "$tsc_entry" ]; then
          echo "TypeScript entry not found at $tsc_entry" >&2
          exit 1
        fi
        bun "$tsc_entry" --project "${typecheckTsconfigChecked}" --noEmit
      fi
    ''}

    build_output="$PWD/.bun-build/${binaryName}"
    mkdir -p "$(dirname "$build_output")"
    substituteInPlace "${entry}" \
      --replace "const buildVersion = '__CLI_VERSION__'" "const buildVersion = '${fullVersion}'"

    bun build "${entry}" \
      --compile \
      --outfile="$build_output"

    bun_binary="${pkgsUnstable.bun}/bin/bun"
    bun_build_tmp="$(find . -maxdepth 2 -type f -name '.*.bun-build' -print | sort -r | head -n 1)"
    if [ -n "$bun_build_tmp" ] && [ -s "$bun_build_tmp" ]; then
      # Bun sometimes leaves the compiled binary in a temp `.*.bun-build` file
      # without moving it to --outfile when running inside Nix builds. We also
      # see cases where --outfile is populated with a raw Bun binary instead of
      # the compiled CLI, so prefer the temp output when that happens.
      if [ ! -s "$build_output" ] || cmp -s "$build_output" "$bun_binary"; then
        cp "$bun_build_tmp" "$build_output"
        chmod 755 "$build_output"
      fi
    fi

    if [ -s "$build_output" ] && cmp -s "$build_output" "$bun_binary"; then
      echo "mk-bun-cli: bun build output matches bun; falling back to bun runtime wrapper" >&2
      touch "$PWD/.bun-build/.use-bun-runtime"
    fi

    if [ ! -s "$build_output" ]; then
      echo "bun build produced an empty ${binaryName} binary" >&2
      exit 1
    fi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    if [ -f ".bun-build/.use-bun-runtime" ]; then
      runtime_root="$out/lib/${binaryName}-runtime"
      mkdir -p "$runtime_root"
      ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
        mkdir -p "$runtime_root/$(dirname "${dir}")"
        cp -R "${dir}" "$runtime_root/${dir}"
      '') installDirsChecked}
      ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
        if [ -d "$runtime_root/${dir}/node_modules" ]; then
          ${pkgs.lib.concatMapStringsSep "\n" (pkg: ''
            pkg_scope="$(dirname "${pkg.name}")"
            if [ "$pkg_scope" != "." ]; then
              mkdir -p "$runtime_root/${dir}/node_modules/$pkg_scope"
            fi
            rm -rf "$runtime_root/${dir}/node_modules/${pkg.name}"
            ln -s "$runtime_root/${pkg.path}" "$runtime_root/${dir}/node_modules/${pkg.name}"
          '') installDirPackages}
        fi
      '') installDirsChecked}
      ${pkgs.lib.concatMapStringsSep "\n" (dir: ''
        if [ -d "$runtime_root/${dir}/node_modules/.bun" ]; then
          types_dir="$runtime_root/${dir}/node_modules/@types"
          node_types_link="$types_dir/node"
          if [ ! -e "$node_types_link" ]; then
            node_types_pkg="$(find "$runtime_root/${dir}/node_modules/.bun" -maxdepth 1 -type d -name '@types+node@*' | sort -V | tail -n 1)"
            if [ -n "$node_types_pkg" ] && [ -d "$node_types_pkg/node_modules/@types/node" ]; then
              mkdir -p "$types_dir"
              ln -s "$node_types_pkg/node_modules/@types/node" "$node_types_link"
            fi
          fi
        fi
      '') installDirsChecked}
      ${pkgs.lib.concatMapStringsSep "\n" (dirSpec: ''
        if [ -d "$runtime_root/${dirSpec.path}/node_modules/.bun" ]; then
          ${pkgs.lib.concatMapStringsSep "\n" (dep: ''
            dep_target="$runtime_root/${dirSpec.path}/node_modules/${dep}"
            if [ ! -e "$dep_target" ]; then
              dep_source="$(find "$runtime_root/${dirSpec.path}/node_modules/.bun" -type d -path "*/node_modules/${dep}" | head -n 1)"
              if [ -n "$dep_source" ]; then
                mkdir -p "$(dirname "$dep_target")"
                ln -s "$dep_source" "$dep_target"
              fi
            fi
          '') dirSpec.deps}
        fi
      '') installDirDependencies}
      cat > "$out/bin/${binaryName}" <<EOF
#!${pkgs.bash}/bin/bash
exec ${pkgsUnstable.bun}/bin/bun "$runtime_root/${entry}" "\$@"
EOF
      chmod 755 "$out/bin/${binaryName}"
    else
      install -m 755 ".bun-build/${binaryName}" $out/bin/${binaryName}
    fi

    runHook postInstall
  '';
}
