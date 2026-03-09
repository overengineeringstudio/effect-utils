# Shared pnpm dependency fetching and restore helpers.
#
# Provides two functions used by both mk-pnpm-cli.nix and oxc-config-plugin.nix:
#
# 1. mkDeps: Creates a fixed-output derivation (FOD) that fetches pnpm dependencies
#    from staged lockfiles by adding their external package set to the pnpm
#    store and archiving the normalized result into a reproducible tarball.
#
# 2. mkRestoreScript: Generates a shell script snippet that extracts the
#    archived pnpm store and configures pnpm for offline installs during the
#    build phase.
#
# By centralizing this logic we avoid duplicating the ~50 lines of pnpm store
# setup, timestamp normalization, and tarball creation across multiple builders.

{ pkgs }:

let
  lib = pkgs.lib;
  pnpmPlatform = import ./pnpm-platform.nix;
in
{
  # Create a fixed-output derivation that fetches pnpm dependencies.
  #
  # Arguments:
  #   name:           Derivation name prefix (e.g., "genie" or "oxc-config")
  #   src:            Filtered source containing the staged workspace root
  #                   package.json, pnpm-lock.yaml, pnpm-workspace.yaml, and
  #                   relevant workspace member manifests / patches.
  #   sourceRoot:     Path within the staged workspace root to cd into before
  #                   install. Use "." for the staged workspace root itself.
  #   pnpmDepsHash:   Expected hash of the FOD output
  #   preInstall:     Extra shell commands to run before lockfile parsing
  #   lockfilePaths:
  #                   Lockfiles that define the allowed package set for store normalization.
  #                   Each path is relative to sourceRoot.
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
        pkgs.cacert
        pkgs.zstd
        pkgs.findutils
      ];

      dontUnpack = true;
      dontConfigure = true;
      dontBuild = true;

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

        export HOME=$PWD
        export STORE_PATH=$PWD/.pnpm-store
        export CI=true
        export NPM_CONFIG_PRODUCTION=false
        export npm_config_production=false
        export npm_config_manage_package_manager_versions=false
        export NODE_ENV=development
        export LOCKFILE_PATHS_JSON='${builtins.toJSON lockfilePaths}'

        pnpm config set store-dir "$STORE_PATH"
        pnpm config set manage-package-manager-versions false
        pnpm config set side-effects-cache false
        ${pnpmPlatform.setupScript}

        node -e '
          const fs = require("fs");

          const lockfilePaths = JSON.parse(process.env.LOCKFILE_PATHS_JSON || "[]");
          const specs = new Set();

          for (const lockfilePath of lockfilePaths) {
            if (!lockfilePath || !fs.existsSync(lockfilePath)) {
              console.error("store-fetch: FATAL — staged lockfile not found at " + lockfilePath);
              process.exit(1);
            }

            const lines = fs.readFileSync(lockfilePath, "utf8").split("\n");
            let inPackages = false;
            for (const line of lines) {
              if (/^packages:\s*$/.test(line)) {
                inPackages = true;
                continue;
              }
              if (inPackages) {
                if (line.length > 0 && line[0] !== " " && line[0] !== "\n") break;
                const m = /^\s{2}("|\x27)?(.+?)\1:\s*$/.exec(line);
                if (!m) continue;
                const key = m[2];
                if (
                  key.startsWith("file:")
                  || key.startsWith("link:")
                  || key.startsWith("workspace:")
                  || !key.includes("@")
                ) continue;
                const spec = key.split("(")[0];
                if (spec.includes("@")) specs.add(spec);
              }
            }
          }

          const sortedSpecs = Array.from(specs).sort();
          if (sortedSpecs.length === 0) {
            console.error("store-fetch: FATAL — no external package specs parsed from staged lockfiles");
            process.exit(1);
          }
          fs.writeFileSync(".pnpm-store-specs.txt", sortedSpecs.join("\n") + "\n");
          console.log("store-fetch: parsed " + sortedSpecs.length + " unique external package specs");
        '

        xargs -r -a .pnpm-store-specs.txt -n 50 pnpm store add

        # Normalize pnpm store for cross-platform/cross-run determinism.
        # See: https://github.com/NixOS/nixpkgs/issues/422889
        #
        # Pipeline overview:
        #   Phase 0: Prune phantom index files not in the staged lockfile
        #   Phase 1: Build CAS file existence set (source of truth for exec status)
        #   Phase 2: Canonicalize index JSON (deterministic mode from CAS filename)
        #   Phase 3: Remove orphan CAS files (not referenced by any index)
        #
        # Phase 0 context: the staged package lockfile is the only dependency
        # source of truth for this fetch input. Pruning any extra index files
        # ensures the archived store cannot drift beyond that lockfile.

        node -e '
          const fs = require("fs");
          const p = require("path");
          const sp = process.env.STORE_PATH;
          const lockfilePaths = JSON.parse(process.env.LOCKFILE_PATHS_JSON || "[]");

          function walk(dir, out) {
            for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
              const fp = p.join(dir, e.name);
              if (e.isDirectory()) walk(fp, out); else out.push(fp);
            }
            return out;
          }

          const vdirs = fs.readdirSync(sp).filter(d => /^v\d+$/.test(d)).sort();
          if (!vdirs.length) { console.log("store-norm: no v* dir found"); process.exit(0); }
          if (vdirs.length !== 1) {
            console.error("store-norm: FATAL — expected exactly one v* dir, found: " + vdirs.join(", "));
            process.exit(1);
          }
          const vdir = p.join(sp, vdirs[0]);

          if (!Array.isArray(lockfilePaths) || lockfilePaths.length === 0) {
            console.error("store-norm: FATAL — no staged lockfiles were provided");
            process.exit(1);
          }

          /* Phase 0: Prune phantom index files not in the staged lockfile. */
          const Q = String.fromCharCode(39); /* single quote */
          const pkgLineRe = new RegExp("^\\s+(" + Q + "?)(.+?)\\1:\\s*$");
          const allowedPkgVersions = new Set();

          for (const lockfilePath of lockfilePaths) {
            if (!lockfilePath || !fs.existsSync(lockfilePath)) {
              console.error("store-norm: FATAL — staged lockfile not found at " + lockfilePath);
              process.exit(1);
            }

            const lockfile = fs.readFileSync(lockfilePath, "utf8");
            const lines = lockfile.split("\n");
            let inPackages = false;
            for (const line of lines) {
              if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
              if (inPackages) {
                if (line.length > 0 && line[0] !== " " && line[0] !== "\n") break;
                const m = pkgLineRe.exec(line);
                if (m && m[2].includes("@")) allowedPkgVersions.add(m[2]);
              }
            }
          }
          console.log("store-norm: parsed staged lockfiles, found " + allowedPkgVersions.size + " unique packages");

          if (allowedPkgVersions.size === 0) {
            console.error("store-norm: FATAL — no packages parsed from staged pnpm-lock.yaml");
            process.exit(1);
          }

          const indexDir = p.join(vdir, "index");
          const allIndex = walk(indexDir, []).filter(f => f.endsWith(".json"));
          let pruned = 0;
          for (const ip of allIndex) {
            /* Extract pkg@version from filename: {hash}-{pkg}@{ver}.json
               Scoped packages use + instead of / in filenames. */
            const basename = p.basename(ip, ".json");
            const dashIdx = basename.indexOf("-");
            if (dashIdx === -1) continue;
            const pkgAtVersion = basename.slice(dashIdx + 1).replace(/\+/g, "/");
            if (!allowedPkgVersions.has(pkgAtVersion)) {
              fs.unlinkSync(ip);
              pruned++;
            }
          }
          const remaining = allIndex.length - pruned;
          if (pruned) console.log("store-norm: pruned " + pruned + " phantom index files");
          console.log("store-norm: " + remaining + " index files remain (from " + allowedPkgVersions.size + " lockfile packages)");

          /* Phase 1: Build CAS file existence set (source of truth for exec status) */
          const filesDir = p.join(vdir, "files");
          const casFiles = new Set();
          if (fs.existsSync(filesDir)) {
            for (const f of walk(filesDir, [])) casFiles.add(f);
          }

          /* Phase 2: Normalize index JSON using CAS file names for exec detection.
             Key insight: the CAS file name (-exec suffix or not) is set during
             initial fetch from the tarball and is deterministic. But the index
             JSON mode field can change non-deterministically due to cross-partition
             hardlink behavior (pnpm flips exec bits on bin entries via hardlinks;
             on same-partition this propagates to the CAS file mode, on cross-
             partition it does not). So we derive exec status from the CAS file
             name (deterministic source of truth), not the index mode. */
          const referenced = new Set();
          const indexDir2 = p.join(vdir, "index");
          const indexFiles = walk(indexDir2, []).filter(f => f.endsWith(".json")).sort();
          for (const ip of indexFiles) {
            const d = JSON.parse(fs.readFileSync(ip, "utf8"));
            if (d.files) {
              const sorted = {};
              for (const k of Object.keys(d.files).sort()) {
                const f = d.files[k];
                const m = f.integrity.match(/^[^-]+-(.+)$/);
                let isExec = false;
                if (m) {
                  const hex = Buffer.from(m[1], "base64").toString("hex");
                  const base = p.join(vdir, "files", hex.slice(0,2), hex.slice(2));
                  const exec = base + "-exec";
                  /* Derive exec from CAS file name, not index mode */
                  if (casFiles.has(exec)) {
                    isExec = true;
                    referenced.add(exec);
                  } else if (casFiles.has(base)) {
                    referenced.add(base);
                  }
                }
                sorted[k] = { checkedAt: 0, integrity: f.integrity, mode: isExec ? 493 : 420, size: f.size };
              }
              d.files = sorted;
            }
            delete d.sideEffects;
            delete d.requiresBuild;
            const out = {};
            for (const k of Object.keys(d).sort()) out[k] = d[k];
            fs.writeFileSync(ip, JSON.stringify(out));
          }

          /* Phase 3: Remove orphan CAS files (not referenced by any index) */
          if (fs.existsSync(filesDir)) {
            let orphans = 0;
            for (const f of walk(filesDir, [])) {
              if (!referenced.has(f)) { fs.unlinkSync(f); orphans++; }
            }
            if (orphans) console.log("store-norm: removed " + orphans + " orphan CAS files");
          }
        '

        # 2. Remove empty directories left after orphan cleanup.
        find "$STORE_PATH" -type d -empty -delete 2>/dev/null || true

        # 3. Remove everything except files/ and index/ — defensive cleanup.
        #    projects/ contains path-dependent symlinks, tmp/ has random names,
        #    and any other dirs pnpm may create are not needed for offline installs.
        for vdir in "$STORE_PATH"/v*/; do
          for entry in "$vdir"*/; do
            case "$(basename "$entry")" in
              files|index) ;;
              *) rm -rf "$entry" ;;
            esac
          done
        done

        # 4. Normalize file permissions — umask can differ across CI runners/sandbox
        #    environments, and tar captures permissions. Following nixpkgs PR #422975.
        find "$STORE_PATH" -type d -exec chmod 755 {} +
        find "$STORE_PATH" -type f -name "*-exec" -exec chmod 555 {} +
        find "$STORE_PATH" -type f ! -name "*-exec" -exec chmod 444 {} +

        # 5. Print diagnostic hashes (helps debug cross-runner non-determinism).
        echo "store-diag: top-dirs=$(ls -1 "$STORE_PATH"/v*/ | tr '\n' ',')"
        echo "store-diag: index-hash=$(find "$STORE_PATH"/v*/index -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
        echo "store-diag: files-hash=$(find "$STORE_PATH"/v*/files -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
        echo "store-diag: files-count=$(find "$STORE_PATH"/v*/files -type f | wc -l)"
        echo "store-diag: index-count=$(find "$STORE_PATH"/v*/index -type f | wc -l)"
        echo "store-diag: symlink-count=$(find "$STORE_PATH" -type l | wc -l)"
        echo "store-diag: exec-files-count=$(find "$STORE_PATH"/v*/files -name '*-exec' | wc -l)"
        echo "store-diag: total-size=$(du -sb "$STORE_PATH" | cut -f1)"

        if find "$STORE_PATH" -type l | grep -q .; then
          echo "store-norm: FATAL — symlinks remain after normalization"
          find "$STORE_PATH" -type l
          exit 1
        fi

        mkdir -p $out
        cd $STORE_PATH
        LC_ALL=C TZ=UTC tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
          --format=gnu --no-acls --no-selinux --no-xattrs -cf - . \
          | zstd -T1 -q -o $out/pnpm-store.tar.zst

        runHook postInstall
      '';

      outputHashMode = "recursive";
      outputHash = pnpmDepsHash;
    };

  # Generate a shell script snippet that restores the pnpm store from a deps
  # derivation and configures pnpm for offline installs.
  #
  # The calling derivation's buildPhase should include this snippet before
  # running `pnpm install --offline`.
  #
  # Arguments:
  #   deps: The derivation returned by mkDeps
  mkRestoreScript =
    { deps }:
    ''
      export HOME=$PWD
      export STORE_PATH=$(mktemp -d)
      export NPM_CONFIG_PRODUCTION=false
      export npm_config_production=false
      export npm_config_manage_package_manager_versions=false
      export NODE_ENV=development

      # Extract pnpm store
      zstd -d -c ${deps}/pnpm-store.tar.zst | tar -xf - -C $STORE_PATH
      chmod -R +w $STORE_PATH

      # Configure pnpm for offline install
      pnpm config set store-dir "$STORE_PATH"
      pnpm config set package-import-method clone-or-copy
      pnpm config set manage-package-manager-versions false
      ${pnpmPlatform.setupScript}
    '';
}
