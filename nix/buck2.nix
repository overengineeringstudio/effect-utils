# Repo-local Buck2 package authority: keep nixpkgs' native-binary derivation
# (unpackCmd/autoPatchelf/installPhase/completions) and replace only the pinned
# release assets plus the compatible Prelude passthru.
#
# CONTRACT: nixpkgs' inherited `installPhase` installs one binary per entry of
# its own `binaries` list and fails hard (`install` with no source operand) if a
# corresponding release asset is missing from `srcs`. So `srcs` must stay a
# SUPERSET of that list. nixpkgs added `starlark_fmt` as a third binary, so the
# asset list below carries it too; when bumping the pin, check upstream's
# `pkgs/by-name/bu/buck2/package.nix` `binaries` list for new entries.
{
  pkgs,
  launcherSource ? pkgs.lib.fileset.toSource {
    root = ../scripts;
    fileset = pkgs.lib.fileset.unions [
      ../scripts/buck2-entrypoint.ts
      ../scripts/buck2-cache-posture.ts
      ../scripts/buck2-file-watcher.ts
      ../scripts/buck2-stdio.c
      ../scripts/buck2-entrypoint.sh
    ];
  },
}:
let
  release = rec {
    version = "2026-11-15";
    releaseBaseUrl = "https://github.com/facebook/buck2/releases/download/${version}";
    prelude = rec {
      revision = "a377c4e4eb69b4bbea2e1309283ec7a699c2fb88";
      url = "https://github.com/facebook/buck2-prelude/archive/${revision}.tar.gz";
      hash = "sha256-zdYh3T0k1hNrgWNjVzWhNPiVgK5m1xfA4TdCAYX4za0=";
    };
    platforms = {
      x86_64-linux = {
        executionPlatform = "x86_64-linux";
        suffix = "x86_64-unknown-linux-gnu";
        buck2Hash = "sha256-UdIJ+DTDUJvIMCS/Tt5izZBxNeeyibKe1p12Pc3mewQ=";
        rustProjectHash = "sha256-e5tR+jJmXE/n5IWySgbn+M56sYEdN8JJHdmU0teGT+M=";
        starlarkFmtHash = "sha256-VRiuSEoFUV8FP4DxVG4dZEFO43T/e6foOXJZqCzgxEw=";
      };
      aarch64-linux = {
        executionPlatform = "aarch64-linux";
        suffix = "aarch64-unknown-linux-gnu";
        buck2Hash = "sha256-xB+ZJuXi3Vi1IOvj6B7/H/jp2Y1JPHG2N4Ik6usWX74=";
        rustProjectHash = "sha256-7pDgUAFdlWtPIAYE9ocP7eFddoUTTmLCa1n27v9+22k=";
        starlarkFmtHash = "sha256-95Fn0AZRVI4uA2GpXqJkMuQCHS8qsn+R/XZcnvMIZNY=";
      };
      aarch64-darwin = {
        executionPlatform = "aarch64-macos";
        suffix = "aarch64-apple-darwin";
        buck2Hash = "sha256-NGTbDEUU+z/3o/NwUMc3vV3RAKLiEIhlMOlax2fToQk=";
        rustProjectHash = "sha256-2YmE5BwuvJ/X7Tub2nX0tT6NjNs/WIHSJH4y0XrPwGU=";
        starlarkFmtHash = "sha256-wHASgCZxEWrr8BD0Nm/ne+beG153e26+59ddvDnEVz4=";
      };
    };
  };
  system = pkgs.stdenv.hostPlatform.system;
  platform =
    release.platforms.${system}
      or (throw "Buck2 release ${release.version} does not support ${system}");
  # Product recipes depend only on the pinned native tool, never launcher inputs.
  native = pkgs.buck2.overrideAttrs (oldAttrs: {
    version = "unstable-${release.version}";
    srcs = [
      (pkgs.fetchurl {
        url = "${release.releaseBaseUrl}/buck2-${platform.suffix}.zst";
        hash = platform.buck2Hash;
      })
      (pkgs.fetchurl {
        url = "${release.releaseBaseUrl}/rust-project-${platform.suffix}.zst";
        hash = platform.rustProjectHash;
      })
      (pkgs.fetchurl {
        url = "${release.releaseBaseUrl}/starlark_fmt-${platform.suffix}.zst";
        hash = platform.starlarkFmtHash;
      })
    ];
    passthru = oldAttrs.passthru // {
      inherit (platform) executionPlatform;
      prelude = pkgs.fetchurl {
        inherit (release.prelude) url hash;
      };
    };
  });
in
pkgs.runCommand native.name
  {
    nativeBuildInputs = [ pkgs.stdenv.cc ];
    passthru = native.passthru // {
      inherit native;
    };
    inherit (native) meta pname version;
  }
  ''
    cp -R ${native}/. "$out/"
    chmod u+w "$out" "$out/bin"
    mkdir -p "$out/libexec"
    mv "$out/bin/buck2" "$out/libexec/buck2"
    cp ${launcherSource}/buck2-entrypoint.ts "$out/libexec/buck2-entrypoint.ts"
    cp ${launcherSource}/buck2-cache-posture.ts "$out/libexec/buck2-cache-posture.ts"
    cp ${launcherSource}/buck2-file-watcher.ts "$out/libexec/buck2-file-watcher.ts"
    ${pkgs.stdenv.cc}/bin/cc ${
      if pkgs.stdenv.hostPlatform.isDarwin then "-dynamiclib" else "-shared -fPIC"
    } \
      ${launcherSource}/buck2-stdio.c \
      -o "$out/libexec/libbuck2-stdio${pkgs.stdenv.hostPlatform.extensions.sharedLibrary}"
    # Darwin clonefile preserves Bun's read-only store mode. Its copy fallback
    # uses TMPDIR, so compiling there would reopen the same clone with O_EXCL.
    # Keep the compile working directory distinct from TMPDIR.
    (
      cd "$(mktemp -d "$TMPDIR/buck2-launcher.XXXXXX")"
      ${pkgs.bun}/bin/bun build --compile "$out/libexec/buck2-entrypoint.ts" \
        --define "BUCK2_STDIO_LIBRARY=\"$out/libexec/libbuck2-stdio${pkgs.stdenv.hostPlatform.extensions.sharedLibrary}\"" \
        --define "BUCK2_EVIDENCE_BUN_BINARY=\"${pkgs.bun}/bin/bun\"" \
        --outfile "$out/libexec/buck2-entrypoint"
    )
    rm "$out/libexec/buck2-entrypoint.ts" "$out/libexec/buck2-cache-posture.ts" "$out/libexec/buck2-file-watcher.ts"
    substitute ${launcherSource}/buck2-entrypoint.sh "$out/bin/buck2" \
      --replace-fail '@shell@' '${pkgs.runtimeShell}' \
      --replace-fail '@native@' "$out/libexec/buck2" \
      --replace-fail '@launcher@' "$out/libexec/buck2-entrypoint" \
      --replace-fail '@sha256@' '${pkgs.coreutils}/bin/sha256sum'
    chmod +x "$out/bin/buck2"
  ''
