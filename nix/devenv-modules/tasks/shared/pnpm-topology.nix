/*
  Installs packages from an explicit local topology projection under `.topologies/`
  instead of running pnpm against the raw checked-out peer repos.

  Relation to the requirements:
  - aligns with node-modules-install R1/R8/R9 by making one install owner
    explicit for the selected topology and failing in one predictable place
  - aligns with R3/R4 because source repos still keep their standalone
    manifests/lockfiles and live source remains in the current worktree
  - aligns with R5 by materializing the package plus its local workspace
    closure into a minimal installable topology
  - aligns partly with bun-cli-build A2/R2 because the projection is derived
    from the canonical worktree and checked-in topology files

  Why this exists:
  - downstream repos keep `workspace:*` / local path deps in source
  - pnpm installs become fragile when raw peer repos bring their own nested
    `pnpm-workspace.yaml` / `pnpm-lock.yaml`
  - the projection makes the selected flake/package root the single install owner
    while still reusing sources from the current worktree

  What the task does:
  - copies the requested package into `.topologies/<task-name>/...`
  - discovers local workspace members and `file:` / `link:` package deps
  - copies those peer packages plus repo-level support files like `patches/`
    and `tsconfig.base.json`
  - strips copied peer package manifests to a minimal exported shape and removes
    nested pnpm metadata so the root topology remains authoritative
  - runs `pnpm install --frozen-lockfile` inside that projection and then
    symlinks the original package's `node_modules` back to the projection

  Follow-up work:
  - downstream Nix builds still need to consume the same topology definition so
    repo-side installs and build-time composition stop diverging
  - the projection should become a first-class shared topology/materialization
    API instead of each flake keeping bespoke build-side assembly logic
  - the end state should rely less on projection-time metadata stripping so we
    get closer to bun-cli-build A3 and reuse canonical manifests/lockfiles more directly

  This keeps local source editing ergonomic while making repo-side installs
  behave like the normalized composed workspace used by downstream builds.
*/
{
  packages,
  globalCache ? true,
  topologyRoot ? ".topologies",
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cache = import ../lib/cache.nix { inherit config; };
  workspaceProjection = import ../../../workspace-tools/lib/workspace-projection.nix { inherit pkgs; };
  cacheRoot = cache.mkCachePath "pnpm-topology-install";
  flock = "${pkgs.flock}/bin/flock";
  rsync = "${pkgs.rsync}/bin/rsync";
  jq = "${pkgs.jq}/bin/jq";
  yq = "${pkgs.yq-go}/bin/yq";
  rm = "${pkgs.coreutils}/bin/rm";
  ln = "${pkgs.coreutils}/bin/ln";
  mkdir = "${pkgs.coreutils}/bin/mkdir";
  cp = "${pkgs.coreutils}/bin/cp";
  dirnameBin = "${pkgs.coreutils}/bin/dirname";
  find = "${pkgs.findutils}/bin/find";
  sha256sum = "${pkgs.coreutils}/bin/sha256sum";

  sanitize = s: builtins.replaceStrings [ "/" "." "@" ] [ "-" "-" "" ] s;

  # Derive a human-readable default task name from the package path first.
  # We only fall back to repo-qualified names when two paths would collide.
  baseName =
    path:
    let
      repoStripped =
        let
          m = builtins.match "repos/[^/]+/packages/(.*)" path;
        in
        if m != null then builtins.head m else path;
      stripped = lib.removePrefix "apps/" (lib.removePrefix "packages/" repoStripped);
      m = builtins.match "@[^/]+/(.*)" stripped;
      final = if m != null then builtins.head m else stripped;
    in
    sanitize final;

  disambiguatedName =
    path:
    let
      repoMatch = builtins.match "repos/([^/]+)/(.*)" path;
      repo = if repoMatch == null then null else builtins.elemAt repoMatch 0;
      repoRelative = if repoMatch == null then path else builtins.elemAt repoMatch 1;
      stripped = lib.removePrefix "apps/" (lib.removePrefix "packages/" repoRelative);
      scopeMatch = builtins.match "@([^/]+)/(.*)" stripped;
      scope = if scopeMatch == null then null else builtins.elemAt scopeMatch 0;
      rest = if scopeMatch == null then stripped else builtins.elemAt scopeMatch 1;
      pieces = lib.filter (x: x != null && x != "") [ repo scope rest ];
    in
    sanitize (lib.concatStringsSep "-" pieces);

  baseTaskNames = map baseName packages;
  duplicateBaseTaskNames = lib.filterAttrs (_: names: builtins.length names > 1) (lib.groupBy (n: n) baseTaskNames);
  toName =
    path:
    let
      name = baseName path;
    in
    if (duplicateBaseTaskNames.${name} or null) != null then disambiguatedName path else name;

  packageTaskNames = map toName packages;
  duplicateTaskNames = lib.filterAttrs (_: names: builtins.length names > 1) (lib.groupBy (n: n) packageTaskNames);
  duplicateTaskNameLines = lib.mapAttrsToList (
    taskName: _:
    let
      conflictingPaths = lib.filter (path: toName path == taskName) packages;
    in
    "- ${taskName}: ${lib.concatStringsSep ", " conflictingPaths}"
  ) duplicateTaskNames;
  ensureUniqueTaskNames =
    if duplicateTaskNames == { } then
      true
    else
      throw ''
        pnpm-topology task name collision detected.
        Conflicting task names (derived from package paths):
        ${lib.concatStringsSep "\n" duplicateTaskNameLines}
      '';

  # Map package.json names back to managed paths so `dependenciesMeta.*.injected`
  # can pull the source of injected workspace deps into the cache key.
  packageNameToPath = builtins.listToAttrs (
    builtins.filter (x: x != null) (
      map (
        path:
        let
          pkgJsonPath = "${config.devenv.root}/${path}/package.json";
          pkgJsonExists = builtins.pathExists pkgJsonPath;
          pkgJson = if pkgJsonExists then builtins.fromJSON (builtins.readFile pkgJsonPath) else { };
          name = pkgJson.name or null;
        in
        if name != null then
          {
            inherit name;
            value = path;
          }
        else
          null
      ) packages
    )
  );

  getInjectedDeps =
    path:
    let
      pkgJsonPath = "${config.devenv.root}/${path}/package.json";
      pkgJson = builtins.fromJSON (builtins.readFile pkgJsonPath);
      depsMeta = pkgJson.dependenciesMeta or { };
      injectedNames = builtins.filter (name: (depsMeta.${name}.injected or false) == true) (builtins.attrNames depsMeta);
    in
    builtins.filter (p: p != null) (map (name: packageNameToPath.${name} or null) injectedNames);

  packagesWithPrev =
    assert ensureUniqueTaskNames;
    lib.imap0 (
      i: path:
      {
        inherit path;
        name = toName path;
        prevName = if i == 0 then null else toName (builtins.elemAt packages (i - 1));
        injected = getInjectedDeps path;
      }
    ) packages;

  computeHashFn = ''
    compute_hash() {
      ${sha256sum} | awk '{print $1}'
    }
  '';

  # Runtime discovery keeps topology parsing out of Nix evaluation and lets the
  # task reflect the current checked-out manifests/workspace files directly.
  mkRuntimeTopologyFns =
    path:
    ''
      resolve_rel_path() {
        python3 - "$1" "$2" <<'PY'
import os
import sys
print(os.path.normpath(os.path.join(sys.argv[1], sys.argv[2])))
PY
      }

      list_workspace_members() {
        if [ ! -f "$DEVENV_ROOT/${path}/pnpm-workspace.yaml" ]; then
          return
        fi
        while IFS= read -r rel; do
          case "$rel" in
            ""|".") continue ;;
          esac
          resolve_rel_path "${path}" "$rel"
        done < <(${yq} '.packages[]' "$DEVENV_ROOT/${path}/pnpm-workspace.yaml" 2>/dev/null | tr -d '"')
      }

      list_local_path_deps() {
        if [ ! -f "$DEVENV_ROOT/${path}/package.json" ]; then
          return
        fi
        ${jq} -r '
          [(.dependencies // {}), (.devDependencies // {}), (.optionalDependencies // {})]
          | add
          | to_entries[]
          | select((.value | type) == "string")
          | .value
          | select(startswith("file:") or startswith("link:"))
        ' "$DEVENV_ROOT/${path}/package.json" | while IFS= read -r spec; do
          rel=''${spec#file:}
          rel=''${rel#link:}
          resolved="$(resolve_rel_path "${path}" "$rel")"
          if [ -f "$DEVENV_ROOT/$resolved/package.json" ]; then
            printf '%s\n' "$resolved"
          fi
        done
      }

      list_peer_package_jsons() {
        { list_workspace_members; list_local_path_deps; } | awk '!seen[$0]++' | while IFS= read -r rel; do
          [ -z "$rel" ] && continue
          if [ -f "$DEVENV_ROOT/$rel/package.json" ]; then
            printf '%s\n' "$rel/package.json"
          fi
        done
      }

      copy_repo_support_for_rel() {
        local rel="$1"
        local repo_root
        case "$rel" in
          repos/*/*) repo_root="$(printf '%s' "$rel" | cut -d/ -f1-2)" ;;
          *) return ;;
        esac
        case " $copied_repo_roots " in
          *" $repo_root "*) return ;;
        esac
        copied_repo_roots="$copied_repo_roots $repo_root"
        for support in tsconfig.base.json patches; do
          if [ -d "$DEVENV_ROOT/$repo_root/$support" ]; then
            copy_tree "$repo_root/$support"
          elif [ -f "$DEVENV_ROOT/$repo_root/$support" ]; then
            ${mkdir} -p "$topology_dir/$(${dirnameBin} "$repo_root/$support")"
            ${cp} "$DEVENV_ROOT/$repo_root/$support" "$topology_dir/$repo_root/$support"
          fi
        done
      }
    '';

  mkComputeCacheHash =
    {
      path,
      injected,
      resultVar,
    }:
    let
      injectedSrcs = lib.concatMapStringsSep " " (dep: "\"$DEVENV_ROOT/${dep}/src\"") injected;
    in
    ''
      ${mkRuntimeTopologyFns path}
      # The cache key tracks the root manifest/lockfile plus copied peer package
      # manifests and injected source files so we rerun installs on topology drift.
      if [ -f pnpm-lock.yaml ]; then
        base_hash="$(cat package.json pnpm-lock.yaml | compute_hash)"
      else
        base_hash="$(cat package.json | compute_hash)"
      fi

      peer_hash="$(
        for rel in $(list_peer_package_jsons); do
          if [ -f "$DEVENV_ROOT/$rel" ]; then
            cat "$DEVENV_ROOT/$rel"
          fi
        done | compute_hash
      )"
      if [ -n "$peer_hash" ]; then
        base_hash="$base_hash $peer_hash"
      fi

      ${
        if injected == [ ] then
          ''
            ${resultVar}="$base_hash"
          ''
        else
          ''
            injected_hash="$(${find} ${injectedSrcs} -type f \\( -name "*.ts" -o -name "*.tsx" \\) -exec cat {} + 2>/dev/null | compute_hash)"
            ${resultVar}="$base_hash $injected_hash"
          ''
      }
    '';

  cleanExcludeArgs = lib.concatMapStringsSep " " (name: "--exclude=${lib.escapeShellArg name}") [
    ".git"
    ".direnv"
    ".devenv"
    ".cache"
    ".turbo"
    ".next"
    ".bun"
    "node_modules"
    "dist"
    "result"
    "coverage"
    "tmp"
    "out"
  ];

  mkMaterializeScript =
    {
      path,
      name,
    }:
    ''
      topology_dir="$DEVENV_ROOT/${topologyRoot}/${name}"
      package_dir="$topology_dir/${path}"
      copied_repo_roots=""

      copy_tree() {
        local rel="$1"
        ${mkdir} -p "$topology_dir/$(${dirnameBin} "$rel")"
        ${rsync} -aL ${cleanExcludeArgs} "$DEVENV_ROOT/$rel/" "$topology_dir/$rel/"
      }

      copy_support() {
        local rel="$1"
        if [ -d "$DEVENV_ROOT/$rel" ]; then
          copy_tree "$rel"
        elif [ -f "$DEVENV_ROOT/$rel" ]; then
          ${mkdir} -p "$topology_dir/$(${dirnameBin} "$rel")"
          ${cp} "$DEVENV_ROOT/$rel" "$topology_dir/$rel"
        fi
      }

      ${workspaceProjection.shellFns}

      ${mkRuntimeTopologyFns path}

      ${rm} -rf "$topology_dir"
      copy_tree "${path}"
      while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        copy_tree "$rel"
        # Keep runtime dependency metadata for copied peers so live source imports
        # can still resolve transitive packages from the projected root install.
        project_workspace_member "$topology_dir/$rel" runtime
        copy_repo_support_for_rel "$rel"
      done < <(list_workspace_members)
      while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        copy_tree "$rel"
        copy_repo_support_for_rel "$rel"
      done < <(list_local_path_deps)
    '';

  mkInstallTask =
    {
      path,
      name,
      prevName,
      injected,
      ...
    }:
    let
      materializeScript = mkMaterializeScript { inherit path name; };
    in
    {
      "pnpm:install:${name}" = {
        description = "Install dependencies for ${name} via explicit topology projection";
        exec = trace.exec "pnpm:install:${name}" ''
          set -euo pipefail
          mkdir -p "${cacheRoot}"
          hash_file="${cacheRoot}/${name}.hash"

          lockfile="${cacheRoot}/pnpm-install.lock"
          exec 200>"$lockfile"
          if ! ${flock} -w 600 200; then
            echo "[pnpm] Install lock timeout after 600s: $lockfile" >&2
            exit 1
          fi

          ${materializeScript}

          cd "$topology_dir/${path}"
          if [ -n "''${CI:-}" ]; then
            pnpm install --config.confirmModulesPurge=false --frozen-lockfile
          else
            pnpm install --config.confirmModulesPurge=false
          fi

          ${rm} -rf "$DEVENV_ROOT/${path}/node_modules"
          ${ln} -sfn "$topology_dir/${path}/node_modules" "$DEVENV_ROOT/${path}/node_modules"

          ${computeHashFn}
          ${mkComputeCacheHash {
            inherit path injected;
            resultVar = "cache_value";
          }}
          ${cache.writeCacheFile ''"$hash_file"''}
        '';
        cwd = path;
        after = if prevName == null then [ ] else [ "pnpm:install:${prevName}" ];
        status = trace.status "pnpm:install:${name}" "hash" ''
          set -euo pipefail
          hash_file="${cacheRoot}/${name}.hash"
          if [ ! -L "node_modules" ] && [ ! -d "node_modules" ]; then
            exit 1
          fi
          if [ ! -f "$hash_file" ]; then
            exit 1
          fi
          ${computeHashFn}
          ${mkComputeCacheHash {
            inherit path injected;
            resultVar = "current_hash";
          }}
          stored_hash="$(cat "$hash_file")"
          # Treat a stale topology hash the same as a missing install so devenv
          # reruns the materialization/install instead of trusting raw node_modules.
          if [ "$current_hash" != "$stored_hash" ]; then
            exit 1
          fi
          exit 0
        '';
      };
    };

  topologyPaths = map (pkg: "${topologyRoot}/${pkg.name}") packagesWithPrev;
  nodeModulesPaths = lib.concatMapStringsSep " " (p: "${p}/node_modules") packages;
  lockFilePaths = lib.concatMapStringsSep " " (p: "${p}/pnpm-lock.yaml") packages;
  pnpmStorePath = "${config.devenv.root}/.pnpm-store";

  mkUpdateStep =
    pkg:
    let
      materializeScript = mkMaterializeScript { inherit (pkg) path name; };
    in
    ''
      echo "Updating ${pkg.path}..."
      (
        set -euo pipefail
        ${materializeScript}
        cd "$topology_dir/${pkg.path}"
        pnpm install --fix-lockfile --config.confirmModulesPurge=false
        ${cp} pnpm-lock.yaml "$DEVENV_ROOT/${pkg.path}/pnpm-lock.yaml"
        ${rm} -rf "$DEVENV_ROOT/${pkg.path}/node_modules"
        ${ln} -sfn "$topology_dir/${pkg.path}/node_modules" "$DEVENV_ROOT/${pkg.path}/node_modules"
      ) || echo "Warning: ${pkg.path} update failed"
    '';

  updateScript = lib.concatStringsSep "\n" (map mkUpdateStep packagesWithPrev);
in
{
  enterShell = lib.mkIf globalCache ''
    export npm_config_cache="$HOME/.cache/pnpm"
  '';

  tasks = lib.mkMerge (
    map mkInstallTask packagesWithPrev
    ++ [
      {
        "pnpm:install" = {
          description = "Install all pnpm dependencies";
          exec = "echo 'All pnpm topology packages installed'";
          after = map (p: "pnpm:install:${toName p}") packages;
        };
        "pnpm:update" = {
          description = "Update all pnpm lockfiles through topology projections";
          after = [ "genie:run" ];
          exec = trace.exec "pnpm:update" ''
            echo "Updating pnpm lockfiles for all topology packages..."
            ${updateScript}
            echo "Lockfiles updated. Run 'dt nix:hash' to update Nix hashes."
          '';
        };
        "pnpm:clean" = {
          description = "Remove node_modules and topology projections for all managed packages";
          exec = trace.exec "pnpm:clean" "rm -rf ${nodeModulesPaths} ${config.devenv.root}/${topologyRoot} ${pnpmStorePath}";
        };
        "pnpm:reset-lock-files" = {
          description = "Remove pnpm lock files for all managed packages (destructive)";
          exec = trace.exec "pnpm:reset-lock-files" "rm -f ${lockFilePaths}";
        };
      }
    ]
  );
}
