{
  pkgs,
  pnpm,
  fixtureRoot ? (../. + "/packages/@overeng/utils/test-fixtures/stylex-next"),
}:

let
  lib = pkgs.lib;
  manifests = [
    "package.json"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ];
  src = lib.fileset.toSource {
    root = fixtureRoot;
    fileset = lib.fileset.unions (map (name: fixtureRoot + "/${name}") manifests);
  };
  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "stylex-next-fixture";
    inherit src;
    # fetchPnpmDeps uses this attribute for its store-normalization helper;
    # our native pnpm package has no Node runtime dependency of its own.
    pnpm = pnpm // {
      nodejs-slim = pkgs.nodejs;
    };
    fetcherVersion = 4;
    # Measure with: nix build .#stylex-next-fixture.pnpmDeps --no-link
    # The fetched store is byte-identical across Linux architectures but not
    # between Linux and Darwin builders, so each system pins its measured hash.
    hash =
      {
        aarch64-darwin = "sha256-T9xUm2wJkLHJMfyijPdHlE29jZY7nMy2gu0qhAMtVg0=";
        aarch64-linux = "sha256-MnhEfl4qpDX1rSXYpE3kdj9XHd69kqU07pegLCmYnLY=";
        x86_64-linux = "sha256-MnhEfl4qpDX1rSXYpE3kdj9XHd69kqU07pegLCmYnLY=";
      }
      .${pkgs.stdenv.hostPlatform.system}
        or (throw "stylex-next-fixture: no pinned pnpm store hash for ${pkgs.stdenv.hostPlatform.system}");
    prePnpmInstall = ''
      # fetchPnpmDeps forwards this impure variable as --registry. Pin it here:
      # an unset daemon environment otherwise replaces the derivation value.
      export NIX_NPM_REGISTRY=https://registry.npmjs.org/
      # Only prefetch realizes the foreign optional packages. The final output
      # retains the original workspace so offline installs select the host.
      cat >> pnpm-workspace.yaml <<'EOF'

      supportedArchitectures:
        os: [linux, darwin]
        cpu: [x64, arm64]
        libc: [glibc, musl]
      EOF
      # pnpm 12 requires this in addition to the fetcher's --force flag.
      export pnpm_config_force_ignores_platform=true
    '';
  };
in
assert lib.assertMsg (pnpm.version == "12.7.0") "stylex-next-fixture requires pnpm 12.7.0";
pkgs.runCommand "stylex-next-fixture"
  {
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.zstd
      pkgs.sqlite
    ];
    passthru = {
      inherit pnpmDeps;
      protocol = "effect-utils/stylex-next-fixture/v1";
    };
  }
  ''
    mkdir -p "$out/store"
    ${lib.concatMapStringsSep "\n" (name: ''cp ${src}/${name} "$out/${name}"'') manifests}
    tar --zstd -xf ${pnpmDeps}/pnpm-store.tar.zst -C "$out/store"
    chmod -R u+w "$out/store"

    # fetcherVersion 4 deliberately stores SQL, not a platform-dependent SQLite
    # file. Restore it outside the fixed-output derivation so consumers receive
    # a complete pnpm store, ready to copy into their writable scratch directory.
    if [ -f "$out/store/v11/index.db.sql" ]; then
      sqlite3 "$out/store/v11/index.db" < "$out/store/v11/index.db.sql"
      rm "$out/store/v11/index.db.sql"
    fi
  ''
