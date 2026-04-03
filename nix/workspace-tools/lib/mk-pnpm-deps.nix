# Shared pnpm dependency preparation and restore helpers.
#
# This intentionally diverges from nixpkgs' pnpm helper shape.
#
# | Aspect              | nixpkgs `fetchPnpmDeps` + `pnpmConfigHook`         | This helper                                  |
# |---------------------|----------------------------------------------------|----------------------------------------------|
# | Cached artifact     | Normalized pnpm store tarball                      | Prepared workspace directory                 |
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
#    manifest-only workspace and stores the resulting prepared install tree as
#    a fixed-output directory.
#
# 2. mkRestoreScript: Generates a shell script snippet that overlays the
#    prepared workspace tree over a full source workspace during the build.
#
# By centralizing this logic we keep pnpm out of downstream build phases and
# avoid duplicating staged-workspace install preparation across builders.

{ pkgs, pnpm }:

let
  lib = pkgs.lib;
  pnpmPlatform = import ./pnpm-platform.nix;
  preparedWorkspacePlaceholder = "/__pnpm_prepared_workspace__";
  nixClosureBytesScript = pkgs.writeText "nix-closure-bytes.cjs" ''
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8");
    if (raw.trim() === "") {
      process.stdout.write("0");
      process.exit(0);
    }
    const data = JSON.parse(raw);
    const item = Array.isArray(data)
      ? (data[0] ?? {})
      : (typeof data === "object" && data !== null ? Object.values(data)[0] ?? {} : {});
    process.stdout.write(String(item.closureSize ?? item.narSize ?? 0));
  '';
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
        pnpm
        pkgs.nodejs
        pkgs.nix
        pkgs.perl
        pkgs.cacert
      ];

      dontUnpack = true;
      dontConfigure = true;
      dontBuild = true;
      dontFixup = true;

      installPhase = ''
                # Keep timing/size instrumentation inside the builder so downstream
                # hash refresh and CI logs can point to the slow phase directly instead
                # of only reporting end-to-end wall clock. The extra helpers add a
                # little shell noise, but they are cheaper than guessing blindly.
                timer_now() {
                  perl -MTime::HiRes=time -e 'printf "%.3f", time'
                }

                timer_elapsed() {
                  perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$1" "$(timer_now)"
                }

                format_bytes() {
                  numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null || echo "$1"'B'
                }

                path_bytes() {
                  if [ -d "$1" ]; then
                    du --apparent-size -sk "$1" 2>/dev/null | awk '{print $1 * 1024}'
                  else
                    stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
                  fi
                }

                file_count() {
                  if [ -d "$1" ]; then
                    find "$1" -type f | wc -l | tr -d ' '
                  else
                    echo 1
                  fi
                }

                nix_closure_bytes() {
                  nix path-info --json --closure-size "$1" 2>/dev/null \
                    | ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nixClosureBytesScript}
                }

                log_path_stats() {
                  local label="$1"
                  local path="$2"
                  if [ ! -e "$path" ]; then
                    return
                  fi

                  local bytes
                  bytes=$(path_bytes "$path")
                  local files
                  files=$(file_count "$path")
                  echo "workspace-prep: stats $label size=$(format_bytes "$bytes") files=$files path=$path"
                }

                log_prep_phase() {
                  local phase="$1"
                  shift
                  echo "workspace-prep: phase=$phase $*"
                }

                log_store_closure() {
                  local label="$1"
                  local path="$2"
                  if [ ! -e "$path" ]; then
                    return
                  fi

                  local closure_bytes
                  closure_bytes=$(nix_closure_bytes "$path" || true)
                  if [ -n "$closure_bytes" ] && [ "$closure_bytes" != "0" ]; then
                    echo "workspace-prep: closure $label size=$(format_bytes "$closure_bytes") path=$path"
                  fi
                }

                SOURCE_DIR="$NIX_BUILD_TOP/source"
                prepStartedAt=$(timer_now)
                sourceCopyStartedAt=$(timer_now)
                mkdir "$SOURCE_DIR"
                cp -r "$src"/. "$SOURCE_DIR"/
                chmod -R +w "$SOURCE_DIR"
                # The staged workspace must start from declared sources only.
                # Self-hosted checkouts and local worktrees can accumulate ignored
                # install artifacts, and pnpm's symlink layout will then collide
                # with those preexisting node_modules trees during materialization.
                find "$SOURCE_DIR" -type d -name node_modules -prune -exec rm -rf {} +
                log_prep_phase "stage-source-copy" "duration=$(timer_elapsed "$sourceCopyStartedAt")s source_root=$sourceRoot"
                log_store_closure "src" "$src"
                log_path_stats "staged-source-copy" "$SOURCE_DIR"

                if [ "$sourceRoot" = "." ]; then
                  cd "$SOURCE_DIR"
                else
                  cd "$SOURCE_DIR/$sourceRoot"
                fi

                runHook preInstall

                ${preInstall}

                # pnpm still mutates store metadata (for example index.db and
                # projects/*), so the Nix build must use a private writable HOME/store
                # even though the final archive is immutable.
                export HOME=$(mktemp -d "$NIX_BUILD_TOP/pnpm-home.XXXXXX")
                export STORE_PATH=$(mktemp -d "$NIX_BUILD_TOP/pnpm-store.XXXXXX")
                export CI=true
                export NPM_CONFIG_PRODUCTION=false
                export npm_config_production=false
                export npm_config_manage_package_manager_versions=false
                export NODE_ENV=development
                export LOCKFILE_PATHS_JSON='${builtins.toJSON lockfilePaths}'

                # pnpm 11 rejects `pnpm config set --global` for keys it considers
                # workspace-only. Use env vars and .npmrc instead.
                # Back up .npmrc before appending build-local settings (restored after install).
                cp .npmrc .npmrc.orig 2>/dev/null || true
                printf 'store-dir=%s\npackage-import-method=clone-or-copy\nside-effects-cache=false\nmanage-package-manager-versions=false\n' "$STORE_PATH" >> .npmrc
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
                  }))];

                  process.stdout.write(installRoots.join("\n") + "\n");
                ' > .pnpm-install-roots.txt
                log_prep_phase "install-roots" "count=$(wc -l < .pnpm-install-roots.txt | tr -d ' ')"

                while IFS= read -r install_root; do
                  [ -n "$install_root" ] || continue

                  if [ ! -f "$install_root/package.json" ] || [ ! -f "$install_root/pnpm-lock.yaml" ]; then
                    echo "workspace-prep: FATAL - staged install root is missing package.json or pnpm-lock.yaml: $install_root"
                    exit 1
                  fi

                  log_prep_phase "install-start" "install_root=$install_root"
                  installStartedAt=$(timer_now)
                  (
                    cd "$install_root"
                    pnpm install --frozen-lockfile --ignore-scripts
                  )
                  log_prep_phase "install" "install_root=$install_root duration=$(timer_elapsed "$installStartedAt")s"
                  log_path_stats "install-root:$install_root-node_modules" "$install_root/node_modules"
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
                # Remove them for the root install plus any nested composed repos.
                find . -type f \( \
                  -path '*/node_modules/.modules.yaml' -o \
                  -path '*/node_modules/.pnpm-workspace-state-*.json' -o \
                  -path '*/node_modules/.pnpm/lock.yaml' \
                \) -delete

                # Restore original .npmrc (remove build-local settings that contain
                # non-deterministic paths like $STORE_PATH).
                if [ -f .npmrc.orig ]; then
                  mv .npmrc.orig .npmrc
                else
                  rm -f .npmrc
                fi

                log_path_stats "prepared-workspace-pre-archive" .
                log_path_stats "pnpm-store-final" "$STORE_PATH"
                rm -rf "$STORE_PATH"
                rm -f .pnpm-install-roots.txt

                find . -type d -exec chmod 755 {} +
                find . -type f -perm /111 -exec chmod 555 {} +
                find . -type f ! -perm /111 -exec chmod 444 {} +

                archiveStartedAt=$(timer_now)
                log_path_stats "prepared-workspace-output" "$SOURCE_DIR"
                # Materialize the prepared workspace directly as the fixed-output
                # directory. This keeps the hash boundary aligned with the actual
                # restored tree and avoids serializer-specific failures for large
                # prepared workspaces.
                #
                # Self-hosted darwin runners have shown `cp -a` spuriously failing
                # with `create_symlink: File exists` while materializing pnpm's
                # symlink-heavy trees into `$out.tmp`, even after clearing the
                # destination. Stream the tree through tar instead so the output
                # model stays recursive without relying on `cp`'s platform-specific
                # directory copy semantics.
                rm -rf "$out"
                mkdir -p "$out"
                (
                  cd "$SOURCE_DIR"
                  tar -cf - .
                ) | (
                  cd "$out"
                  tar -xf -
                )
                log_prep_phase "archive" "duration=$(timer_elapsed "$archiveStartedAt")s mode=tar-stream-copy"
                log_prep_phase "complete" "duration=$(timer_elapsed "$prepStartedAt")s output_hash=${pnpmDepsHash}"

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
  #   target: Directory to overlay the prepared workspace into
  #   label: Stable install-root label used in restore timing logs
  mkRestoreScript =
    {
      deps,
      target ? ".",
      label ? "prepared-workspace",
    }:
    ''
            restore_timer_now() {
              perl -MTime::HiRes=time -e 'printf "%.3f", time'
            }

            restore_timer_elapsed() {
              perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$1" "$(restore_timer_now)"
            }

            restore_format_bytes() {
              numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null || echo "$1"'B'
            }

            restore_path_bytes() {
              if [ -d "$1" ]; then
                du --apparent-size -sk "$1" 2>/dev/null | awk '{print $1 * 1024}'
              else
                stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
              fi
            }

            restore_file_count() {
              if [ -d "$1" ]; then
                find "$1" -type f | wc -l | tr -d ' '
              else
                echo 1
              fi
            }

            restoreStartedAt=$(restore_timer_now)
            mkdir -p ${lib.escapeShellArg target}
            # Restore with overlay semantics because the caller's target already
            # contains the real source tree.
            cp -a ${deps}/. ${lib.escapeShellArg target}/

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

            restored_bytes=$(restore_path_bytes "$PREPARED_WORKSPACE_TARGET")
            restored_files=$(restore_file_count "$PREPARED_WORKSPACE_TARGET")
            echo "workspace-restore: phase=restore label=${label} target=$PREPARED_WORKSPACE_TARGET duration=$(restore_timer_elapsed "$restoreStartedAt")s size=$(restore_format_bytes "$restored_bytes") files=$restored_files"
    '';
}
