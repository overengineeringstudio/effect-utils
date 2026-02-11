# Shared pnpm dependency fetching and restore helpers.
#
# Provides two functions used by both mk-pnpm-cli.nix and oxc-config-plugin.nix:
#
# 1. mkDeps: Creates a fixed-output derivation (FOD) that fetches pnpm dependencies
#    with network access and archives them into a reproducible tarball.
#
# 2. mkRestoreScript: Generates a shell script snippet that extracts the archived
#    pnpm store and configures pnpm for offline installs during the build phase.
#
# By centralizing this logic we avoid duplicating the ~50 lines of pnpm store
# setup, timestamp normalization, and tarball creation across multiple builders.

{ pkgs }:

let
  pnpmPlatform = import ./pnpm-platform.nix;
in
{
  # Create a fixed-output derivation that fetches pnpm dependencies.
  #
  # Arguments:
  #   name:           Derivation name prefix (e.g., "genie" or "oxc-config")
  #   src:            Filtered source containing package.json + pnpm-lock.yaml
  #   sourceRoot:     Path within the source to cd into (e.g., "source/packages/@overeng/genie")
  #   pnpmDepsHash:   Expected hash of the FOD output
  #   preInstall:     Extra shell commands to run before pnpm install (e.g., chmod for workspace members)
  #   installFlags:   Extra flags for pnpm install (e.g., "--force --recursive")
  #   fetchFlags:     Extra flags for pnpm fetch (e.g., "--recursive")
  mkDeps =
    {
      name,
      src,
      sourceRoot,
      pnpmDepsHash,
      preInstall ? "",
      installFlags ? "",
      fetchFlags ? "",
    }:
    pkgs.stdenvNoCC.mkDerivation {
      pname = "${name}-pnpm-deps";
      version = "0.0.0";

      inherit src sourceRoot;

      nativeBuildInputs = [
        pkgs.pnpm
        pkgs.nodejs
        pkgs.cacert
        pkgs.zstd
        pkgs.findutils
      ];

      dontConfigure = true;
      dontBuild = true;

      installPhase = ''
        runHook preInstall

        ${preInstall}

        export HOME=$PWD
        export STORE_PATH=$PWD/.pnpm-store
        export NPM_CONFIG_PRODUCTION=false
        export npm_config_production=false
        export NODE_ENV=development

        pnpm config set store-dir "$STORE_PATH"
        pnpm config set manage-package-manager-versions false
        ${pnpmPlatform.setupScript}

        pnpm install --frozen-lockfile --ignore-scripts ${installFlags}
        pnpm fetch --frozen-lockfile ${fetchFlags}

        # Normalize pnpm store for cross-platform/cross-run determinism.
        # See: https://github.com/NixOS/nixpkgs/issues/422889

        # 1. Canonicalize index JSON, normalize CAS file names, and remove orphans.
        #    Eliminates non-determinism from: checkedAt timestamps, mode values
        #    (umask-dependent), sideEffects/requiresBuild (platform-dependent),
        #    JSON key ordering, -exec suffix inconsistency (cross-partition
        #    hardlinks, see NixOS/nixpkgs#422889), and orphan CAS files.
        node -e '
          const fs = require("fs");
          const p = require("path");
          const sp = process.env.STORE_PATH;

          /* Recursive file walker */
          function walk(dir, out) {
            for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
              const fp = p.join(dir, e.name);
              if (e.isDirectory()) walk(fp, out); else out.push(fp);
            }
            return out;
          }

          /* Find the v* directory (e.g. v10) */
          const vdirs = fs.readdirSync(sp).filter(d => /^v\d+$/.test(d));
          if (!vdirs.length) { console.log("store-norm: no v* dir found"); process.exit(0); }
          const vdir = p.join(sp, vdirs[0]);

          /* Phase 1: Normalize index JSON + collect referenced CAS paths */
          const referenced = new Set();
          const indexDir = p.join(vdir, "index");
          const indexFiles = walk(indexDir, []).filter(f => f.endsWith(".json"));
          for (const ip of indexFiles) {
            const d = JSON.parse(fs.readFileSync(ip, "utf8"));
            if (d.files) {
              const sorted = {};
              for (const k of Object.keys(d.files).sort()) {
                const f = d.files[k];
                const isExec = !!(f.mode & 0o111);
                sorted[k] = { checkedAt: 0, integrity: f.integrity, mode: isExec ? 493 : 420, size: f.size };
                const m = f.integrity.match(/^[^-]+-(.+)$/);
                if (m) {
                  const hex = Buffer.from(m[1], "base64").toString("hex");
                  const base = p.join(vdir, "files", hex.slice(0,2), hex.slice(2));
                  const exec = base + "-exec";
                  const target = isExec ? exec : base;
                  const other = isExec ? base : exec;
                  referenced.add(target);
                  if (!fs.existsSync(target) && fs.existsSync(other)) fs.renameSync(other, target);
                }
              }
              d.files = sorted;
            }
            delete d.sideEffects;
            delete d.requiresBuild;
            const out = {};
            for (const k of Object.keys(d).sort()) out[k] = d[k];
            fs.writeFileSync(ip, JSON.stringify(out));
          }

          /* Phase 2: Remove orphan CAS files (not referenced by any index) */
          const filesDir = p.join(vdir, "files");
          if (fs.existsSync(filesDir)) {
            let orphans = 0;
            for (const f of walk(filesDir, [])) {
              if (!referenced.has(f)) { fs.unlinkSync(f); orphans++; }
            }
            if (orphans) console.log("store-norm: removed " + orphans + " orphan CAS files");
          }
        '

        # 2. Remove everything except files/ and index/ — defensive cleanup.
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

        # 3. Normalize file permissions — umask can differ across CI runners/sandbox
        #    environments, and tar captures permissions. Following nixpkgs PR #422975.
        find "$STORE_PATH" -type d -exec chmod 755 {} +
        find "$STORE_PATH" -type f -name "*-exec" -exec chmod 555 {} +
        find "$STORE_PATH" -type f ! -name "*-exec" -exec chmod 444 {} +

        # 4. Print diagnostic hashes (helps debug cross-runner non-determinism).
        echo "store-diag: top-dirs=$(ls -1 "$STORE_PATH"/v*/ | tr '\n' ',')"
        echo "store-diag: index-hash=$(find "$STORE_PATH"/v*/index -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
        echo "store-diag: files-hash=$(find "$STORE_PATH"/v*/files -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
        echo "store-diag: files-count=$(find "$STORE_PATH"/v*/files -type f | wc -l)"
        echo "store-diag: index-count=$(find "$STORE_PATH"/v*/index -type f | wc -l)"
        echo "store-diag: symlink-count=$(find "$STORE_PATH" -type l | wc -l)"
        echo "store-diag: exec-files-count=$(find "$STORE_PATH"/v*/files -name '*-exec' | wc -l)"
        echo "store-diag: total-size=$(du -sb "$STORE_PATH" | cut -f1)"

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
