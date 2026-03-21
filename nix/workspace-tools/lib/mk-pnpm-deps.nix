# Shared pnpm dependency preparation and restore helpers.
#
# This intentionally diverges from nixpkgs' pnpm helper shape.
#
# | Aspect              | nixpkgs `fetchPnpmDeps` + `pnpmConfigHook`         | This helper                                  |
# |---------------------|----------------------------------------------------|----------------------------------------------|
# | Cached artifact     | Normalized pnpm store tarball                      | Prepared install tree tarball                |
# | Downstream behavior | Restores store, then runs `pnpm install --offline` | Restores prepared tree, skips pnpm entirely  |
# | Primary goal        | Generic packaging and broad cache reuse            | Fast downstream CLI builds in staged workspaces |
# | Monorepo model      | Generic pnpm workspace filters                     | Custom staged workspace + install-root model |
# | Cache reuse         | Better across packages sharing one store           | Worse, because prepared trees are more specific |
# | Determinism surface | Mostly pnpm store contents                         | Store contents plus pnpm metadata and shims  |
# | Complexity          | Lower, upstream-maintained                         | Higher, repo-specific normalization logic    |
#
# We choose the second column because this repo's staged megarepo workspace is
# heavily filtered and install-root-specific, and repeating `pnpm install` in
# every CLI build was the main wall-time and disk-pressure bottleneck.
# Downstream repos should therefore follow `effect-utils/nixpkgs` when they
# consume these prepared trees so the full builder graph stays canonical.
#
# Provides two functions used by both mk-pnpm-cli.nix and oxc-config-plugin.nix:
#
# 1. mkDeps: Creates a fixed-output derivation (FOD) that installs a staged
#    manifest-only workspace and archives the resulting prepared install tree.
#
# 2. mkRestoreScript: Generates a shell script snippet that extracts the
#    prepared workspace tree over a full source workspace during the build.
#
# By centralizing this logic we keep pnpm out of downstream build phases and
# avoid duplicating staged-workspace install preparation across builders.

{ pkgs }:

let
  lib = pkgs.lib;
  pnpmPlatform = import ./pnpm-platform.nix;
  preparedWorkspacePlaceholder = "/__pnpm_prepared_workspace__";
in
{
  # Create a fixed-output derivation that prepares a workspace install tree.
  #
  # Arguments:
  #   name:           Derivation name prefix (e.g., "genie" or "oxc-config")
  #   src:            Filtered source containing the staged workspace root
  #                   package.json, pnpm-lock.yaml, pnpm-workspace.yaml, and
  #                   relevant workspace member manifests / patches. The staged
  #                   tree should contain only files needed for deterministic
  #                   installs so source-only edits do not invalidate the FOD.
  #   sourceRoot:     Path within the staged workspace root to cd into before
  #                   install. Use "." for the staged workspace root itself.
  #   pnpmDepsHash:   Expected hash of the FOD output
  #   preInstall:     Extra shell commands to run before lockfile parsing
  #   lockfilePaths:
  #                   Lockfiles whose directories should be installed within the
  #                   staged tree. Each path is relative to sourceRoot.
  mkDeps =
    {
      name,
      src,
      sourceRoot,
      pnpmDepsHash,
      preInstall ? "",
      lockfilePaths ? [ "pnpm-lock.yaml" ],
    }:
    let
      # Embed a fingerprint of the FOD's inputs (lockfile, package.json, etc.)
      # in the derivation name. When inputs change, the name changes, which
      # makes Nix treat this as a NEW derivation — bypassing any cached output
      # from the local store or binary caches (cachix).
      #
      # Without this, a binary cache can serve old (previously valid) outputs
      # indefinitely, masking stale pnpmDepsHash values. The `nix build` command
      # trusts local store content and never re-verifies the hash.
      #
      # See: https://blog.eigenvalue.net/nix-rerunning-fixed-output-derivations/
      #
      # NOTE: This does NOT cover npm registry content drift (a tarball
      # republished with different content at the same version). In that case
      # the lockfile stays the same, so the fingerprint doesn't change and
      # cachix can still serve a stale output. The CI store eviction in
      # nix-cli.nix handles that edge case by deleting cached pnpm-deps
      # outputs before building.
      #
      # TODO(nix-ca): Replace with content-addressed (CA) derivations once the
      # experimental feature is production-ready and binary cache support is
      # complete. CA derivations eliminate manually-maintained FOD hashes entirely.
      # Track: NixOS/nix#6623
      srcFingerprint = builtins.substring 0 8 (
        builtins.unsafeDiscardStringContext (baseNameOf (toString src))
      );
    in
    pkgs.stdenvNoCC.mkDerivation {
      pname = "${name}-pnpm-deps-${srcFingerprint}-v3";
      version = "0.0.0";

      inherit src sourceRoot;

      nativeBuildInputs = [
        pkgs.pnpm
        pkgs.nodejs
        pkgs.python3
        pkgs.cacert
        pkgs.zstd
      ];

      dontUnpack = true;
      dontConfigure = true;
      dontBuild = true;
      dontFixup = true;

      installPhase = ''
        mkdir source
        cp -r "$src"/. source/
        chmod -R +w source

        if [ "$sourceRoot" = "." ]; then
          cd source
        else
          cd "source/$sourceRoot"
        fi

        runHook preInstall

        ${preInstall}

        export HOME=$(mktemp -d "$NIX_BUILD_TOP/pnpm-home.XXXXXX")
        export STORE_PATH=$(mktemp -d "$NIX_BUILD_TOP/pnpm-store.XXXXXX")
        export CI=true
        export NPM_CONFIG_PRODUCTION=false
        export npm_config_production=false
        export npm_config_manage_package_manager_versions=false
        export NODE_ENV=development
        export LOCKFILE_PATHS_JSON='${builtins.toJSON lockfilePaths}'

        pnpm config set store-dir "$STORE_PATH"
        pnpm config set package-import-method clone-or-copy
        pnpm config set manage-package-manager-versions false
        pnpm config set side-effects-cache false
        ${pnpmPlatform.setupScript}

        node -e '
          const path = require("path");
          const lockfilePaths = JSON.parse(process.env.LOCKFILE_PATHS_JSON || "[]");
          if (!Array.isArray(lockfilePaths) || lockfilePaths.length === 0) {
            console.error("workspace-prep: FATAL - no staged lockfiles were provided");
            process.exit(1);
          }

          const installRoots = [...new Set(lockfilePaths.map((lockfilePath) => {
            const dir = path.dirname(lockfilePath);
            return dir === "" ? "." : dir;
          }))].sort();

          process.stdout.write(installRoots.join("\n") + "\n");
        ' > .pnpm-install-roots.txt

        while IFS= read -r install_root; do
          [ -n "$install_root" ] || continue

          if [ ! -f "$install_root/package.json" ] || [ ! -f "$install_root/pnpm-lock.yaml" ]; then
            echo "workspace-prep: FATAL - staged install root is missing package.json or pnpm-lock.yaml: $install_root"
            exit 1
          fi

          echo "workspace-prep: installing $install_root"
          (
            cd "$install_root"
            pnpm install --frozen-lockfile --ignore-scripts
            # pnpm still prunes linux-musl optional deps on Linux during the
            # first install even when supportedArchitectures spans linux/darwin
            # and x64/arm64. A second musl-targeted pass materializes the full
            # cross-platform closure that matches macOS.
            pnpm install --frozen-lockfile --ignore-scripts --force --libc=musl
          )
        done < .pnpm-install-roots.txt

        export PREPARED_WORKSPACE_PLACEHOLDER='${preparedWorkspacePlaceholder}'
        node <<'NODE'
        const fs = require("fs");
        const path = require("path");

        const workspaceRoot = process.cwd();
        const workspaceRealRoot = fs.realpathSync(workspaceRoot);
        const workspacePlaceholder = process.env.PREPARED_WORKSPACE_PLACEHOLDER;

        const rewriteTextFile = (filePath, transform) => {
          if (!fs.existsSync(filePath)) {
            return;
          }

          const next = transform(fs.readFileSync(filePath, "utf8"));
          fs.writeFileSync(filePath, next);
        };

        /**
         * Deterministic directory traversal is critical here because we mutate
         * the prepared tree in-place before archiving it. If pnpm layout
         * rewrites happen in filesystem iteration order, the fixed-output hash
         * can drift across machines even when the final archive writer is sorted.
         */
        const sortedDirEntries = (dirPath) =>
          fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) =>
            left.name.localeCompare(right.name)
          );

        // pnpm virtual packages for workspace `file:` deps should point back to
        // the staged workspace members, not copied package snapshots, or the
        // prepared tree will bake in install-root-specific absolute paths.
        const workspacePackages = new Map();

        const collectWorkspacePackages = (dirPath) => {
          for (const entry of sortedDirEntries(dirPath)) {
            if (!entry.isDirectory()) {
              continue;
            }

            if (entry.name === "node_modules" || entry.name === ".git") {
              continue;
            }

            const entryPath = path.join(dirPath, entry.name);
            const packageJsonPath = path.join(entryPath, "package.json");
            if (fs.existsSync(packageJsonPath)) {
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
              if (typeof packageJson.name === "string" && !workspacePackages.has(packageJson.name)) {
                workspacePackages.set(packageJson.name, entryPath);
              }
            }

            collectWorkspacePackages(entryPath);
          }
        };

        const packageDirsInNodeModules = (nodeModulesPath) => {
          if (!fs.existsSync(nodeModulesPath)) {
            return [];
          }

          const packageDirs = [];
          for (const entry of sortedDirEntries(nodeModulesPath)) {
            if (!entry.isDirectory()) {
              continue;
            }

            if (entry.name.startsWith("@")) {
              const scopeDir = path.join(nodeModulesPath, entry.name);
              for (const scopedEntry of sortedDirEntries(scopeDir)) {
                if (scopedEntry.isDirectory()) {
                  packageDirs.push(path.join(scopeDir, scopedEntry.name));
                }
              }
            } else {
              packageDirs.push(path.join(nodeModulesPath, entry.name));
            }
          }

          return packageDirs;
        };

        const relinkLocalVirtualPackages = (dirPath) => {
          for (const entry of sortedDirEntries(dirPath)) {
            if (!entry.isDirectory()) {
              continue;
            }

            const entryPath = path.join(dirPath, entry.name);
            if (entry.name === ".pnpm") {
              for (const virtualEntry of sortedDirEntries(entryPath)) {
                if (!virtualEntry.isDirectory() || !virtualEntry.name.includes("file+")) {
                  continue;
                }

                const virtualNodeModulesPath = path.join(entryPath, virtualEntry.name, "node_modules");
                for (const packageDir of packageDirsInNodeModules(virtualNodeModulesPath)) {
                  const packageJsonPath = path.join(packageDir, "package.json");
                  if (!fs.existsSync(packageJsonPath)) {
                    continue;
                  }

                  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
                  const workspacePackageDir = workspacePackages.get(packageJson.name);
                  if (!workspacePackageDir) {
                    continue;
                  }

                  fs.rmSync(packageDir, { recursive: true, force: true });
                  fs.symlinkSync(path.relative(path.dirname(packageDir), workspacePackageDir), packageDir, "dir");
                }
              }
            } else {
              relinkLocalVirtualPackages(entryPath);
            }
          }
        };

        collectWorkspacePackages(workspaceRoot);
        relinkLocalVirtualPackages(workspaceRoot);

        const rewriteBinScripts = (dirPath, visitedRealPaths = new Set()) => {
          const realDirPath = fs.realpathSync(dirPath);
          if (visitedRealPaths.has(realDirPath)) {
            return;
          }
          visitedRealPaths.add(realDirPath);

          for (const entry of sortedDirEntries(dirPath)) {
            const entryPath = path.join(dirPath, entry.name);
            const isDirectory =
              entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(entryPath).isDirectory());

            if (!isDirectory) {
              continue;
            }

            if (entry.name === ".bin") {
              for (const binEntry of sortedDirEntries(entryPath)) {
                if (!binEntry.isFile()) {
                  continue;
                }
                rewriteTextFile(path.join(entryPath, binEntry.name), (script) =>
                  script.split(workspaceRoot).join(workspacePlaceholder)
                );
              }
              continue;
            }

            rewriteBinScripts(entryPath, visitedRealPaths);
          }
        };

        rewriteBinScripts(workspaceRoot);
NODE

        # These pnpm bookkeeping files are only needed for future pnpm
        # operations. Downstream builders restore a prepared tree and go
        # straight to bun, so keeping them only widens the determinism surface.
        rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json

        rm -rf "$STORE_PATH"
        rm -f .pnpm-install-roots.txt

        find . -type d -exec chmod 755 {} +
        find . -type f -perm /111 -exec chmod 555 {} +
        find . -type f ! -perm /111 -exec chmod 444 {} +

        mkdir -p $out
        export PREPARED_WORKSPACE_ARCHIVE=$(mktemp "$NIX_BUILD_TOP/prepared-workspace.XXXXXX.tar")
        python <<'PY'
import os
import stat
import tarfile

workspace_root = os.getcwd()
archive_path = os.environ["PREPARED_WORKSPACE_ARCHIVE"]

def build_tarinfo(path: str, arcname: str) -> tarfile.TarInfo:
    st = os.lstat(path)
    info = tarfile.TarInfo(arcname)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0

    if stat.S_ISDIR(st.st_mode):
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
    elif stat.S_ISLNK(st.st_mode):
        info.type = tarfile.SYMTYPE
        info.mode = 0o777
        info.linkname = os.readlink(path)
    elif stat.S_ISREG(st.st_mode):
        info.type = tarfile.REGTYPE
        info.mode = 0o555 if st.st_mode & 0o111 else 0o444
        info.size = st.st_size
    else:
        raise RuntimeError(f"Unsupported file type in prepared workspace: {path}")

    return info

def add_path(archive: tarfile.TarFile, path: str, arcname: str) -> None:
    info = build_tarinfo(path, arcname)
    if info.isreg():
        with open(path, "rb") as handle:
            archive.addfile(info, handle)
    else:
        archive.addfile(info)

with tarfile.open(archive_path, mode="w", format=tarfile.GNU_FORMAT) as archive:
    add_path(archive, workspace_root, ".")

    for current_root, dirnames, filenames in os.walk(workspace_root):
        dirnames.sort()
        filenames.sort()

        for dirname in dirnames:
            path = os.path.join(current_root, dirname)
            relpath = os.path.relpath(path, workspace_root)
            add_path(archive, path, f"./{relpath}")

        for filename in filenames:
            path = os.path.join(current_root, filename)
            relpath = os.path.relpath(path, workspace_root)
            add_path(archive, path, f"./{relpath}")
PY
        zstd -T1 -q "$PREPARED_WORKSPACE_ARCHIVE" -o $out/prepared-workspace.tar.zst
        rm -f "$PREPARED_WORKSPACE_ARCHIVE"

        runHook postInstall
      '';

      outputHashMode = "recursive";
      outputHash = pnpmDepsHash;
    };

  # Generate a shell script snippet that restores a prepared workspace tree.
  #
  # The calling derivation's buildPhase should include this snippet after
  # materializing the full source workspace so the prepared node_modules tree
  # overlays the real source files.
  #
  # Arguments:
  #   deps: The derivation returned by mkDeps
  #   target: Directory to extract the prepared workspace into
  mkRestoreScript =
    {
      deps,
      target ? ".",
    }:
    ''
      mkdir -p ${lib.escapeShellArg target}
      zstd -d -c ${deps}/prepared-workspace.tar.zst | tar -xf - -C ${lib.escapeShellArg target}

      export PREPARED_WORKSPACE_PLACEHOLDER='${preparedWorkspacePlaceholder}'
      export PREPARED_WORKSPACE_TARGET="$(cd ${lib.escapeShellArg target} && pwd -P)"

      find "$PREPARED_WORKSPACE_TARGET" -path '*/.bin/*' -type f -exec chmod u+w {} +

      node <<'NODE'
      const fs = require("fs");
      const path = require("path");

      const workspacePlaceholder = process.env.PREPARED_WORKSPACE_PLACEHOLDER;
      const workspaceTarget = process.env.PREPARED_WORKSPACE_TARGET;

      const rewriteTextFile = (filePath) => {
        if (!fs.existsSync(filePath)) {
          return;
        }

        const current = fs.readFileSync(filePath, "utf8");
        const next = current.split(workspacePlaceholder).join(workspaceTarget);
        if (next !== current) {
          fs.writeFileSync(filePath, next);
        }
      };

      const rewriteBinScripts = (dirPath, visitedRealPaths = new Set()) => {
        const realDirPath = fs.realpathSync(dirPath);
        if (visitedRealPaths.has(realDirPath)) {
          return;
        }
        visitedRealPaths.add(realDirPath);

        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          const entryPath = path.join(dirPath, entry.name);
          const isDirectory =
            entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(entryPath).isDirectory());

          if (!isDirectory) {
            continue;
          }

          if (entry.name === ".bin") {
            for (const binEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
              if (binEntry.isFile()) {
                rewriteTextFile(path.join(entryPath, binEntry.name));
              }
            }
            continue;
          }

          rewriteBinScripts(entryPath, visitedRealPaths);
        }
      };

      rewriteBinScripts(workspaceTarget);
NODE
    '';
}
