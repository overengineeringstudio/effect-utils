{
  description = "mk-pnpm-cli downstream flake-input fixture";

  inputs = {
    effect-utils.url = "path:../effect-utils";
    nixpkgs.follows = "effect-utils/nixpkgs";
    flake-utils.follows = "effect-utils/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      effect-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
        effectUtilsPackages = effect-utils.packages.${system};
        effectUtilsSource = effect-utils;
        pinnedPnpm = import "${effectUtilsSource}/nix/pnpm.nix" { inherit pkgs; };
        derivedWorkspaceRoot = pkgs.runCommand "mk-pnpm-cli-derived-workspace-root" { } ''
          cp -R ${./fixture-workspace} "$out"
          chmod -R +w "$out"
        '';
        mkPnpmCliFactory = import "${effectUtilsSource}/nix/workspace-tools/lib/mk-pnpm-cli.nix";
        mkPnpmCli = mkPnpmCliFactory (
          {
            pkgs = pkgs // {
              bun = pkgs.bun;
              pnpm = pinnedPnpm;
            };
          }
          // lib.optionalAttrs (builtins.hasAttr "pnpm" (builtins.functionArgs mkPnpmCliFactory)) {
            pnpm = pinnedPnpm;
          }
        );
        pureEvalFixture = mkPnpmCli {
          name = "mk-pnpm-cli-pure-eval-fixture";
          binaryName = "mk-pnpm-cli-pure-eval-fixture";
          entry = "app/src/mod.ts";
          packageDir = "app";
          workspaceRoot = ./fixture-workspace;
          workspaceSources = {
            "repos/effect-utils" = effectUtilsSource;
          };
          depsBuilds = {
            "." = {
              hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
            };
            "repos/effect-utils" = {
              hash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
            };
          };
          smokeTestArgs = [ ];
        };
        pureEvalDerivedWorkspaceFixture = mkPnpmCli {
          name = "mk-pnpm-cli-pure-eval-derived-workspace-fixture";
          binaryName = "mk-pnpm-cli-pure-eval-derived-workspace-fixture";
          entry = "app/src/mod.ts";
          packageDir = "app";
          workspaceRoot = derivedWorkspaceRoot;
          workspaceSources = {
            "repos/effect-utils" = effectUtilsSource;
          };
          depsBuilds = {
            "." = {
              hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
            };
            "repos/effect-utils" = {
              hash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
            };
          };
          smokeTestArgs = [ ];
        };
        # Two consumers that differ ONLY in `name` but share the same external
        # install-root profile. Their prepared deps for that shared root must
        # collapse to one in-store derivation (profileKey dedup), while their
        # consumer-specific root (".") derivations stay distinct.
        mkProfileDedupConsumer =
          consumerName:
          mkPnpmCli {
            name = consumerName;
            binaryName = consumerName;
            entry = "app/src/mod.ts";
            packageDir = "app";
            workspaceRoot = ./fixture-workspace;
            workspaceSources = {
              "repos/effect-utils" = effectUtilsSource;
            };
            depsBuilds = {
              "." = {
                hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
              };
              "repos/effect-utils" = {
                hash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
              };
            };
            smokeTestArgs = [ ];
          };
        profileDedupConsumerA = mkProfileDedupConsumer "profile-dedup-consumer-alpha";
        profileDedupConsumerB = mkProfileDedupConsumer "profile-dedup-consumer-bravo";
      in
      {
        packages = {
          genie = effectUtilsPackages.genie;
          megarepo = effectUtilsPackages.megarepo;
          "mk-pnpm-cli-pure-eval-fixture" = pureEvalFixture;
          oxlint-npm = effectUtilsPackages.oxlint-npm;
          default = effectUtilsPackages.megarepo;
        };
        checks.pure-eval-external-install-roots = pkgs.runCommand "mk-pnpm-cli-pure-eval" { } ''
          actual='${builtins.toJSON (map (root: root.installDir) pureEvalFixture.passthru.installRoots)}'
          expected='[".","repos/effect-utils"]'
          if [ "$actual" != "$expected" ]; then
            echo "unexpected install roots: $actual" >&2
            exit 1
          fi
          printf '%s' "$actual" > "$out"
        '';
        checks.pure-eval-deps-build-metadata =
          pkgs.runCommand "mk-pnpm-cli-pure-eval-deps-build-metadata" { }
            ''
              actual='${
                builtins.toJSON {
                  entryAttrNames = map (entry: entry.attrName) pureEvalFixture.passthru.depsBuildEntries;
                  entryDirs = map (entry: entry.dir) pureEvalFixture.passthru.depsBuildEntries;
                  entryDrvPathsAreDrv = map (
                    entry: builtins.match ".*\\.drv" entry.drvPath != null
                  ) pureEvalFixture.passthru.depsBuildEntries;
                  byInstallRootKeys = builtins.sort builtins.lessThan (
                    builtins.attrNames pureEvalFixture.passthru.depsBuildsByInstallRoot
                  );
                }
              }'
              expected='{"byInstallRootKeys":["repos-effect-utils","root"],"entryAttrNames":["root","repos-effect-utils"],"entryDirs":[".","repos/effect-utils"],"entryDrvPathsAreDrv":[true,true]}'
              if [ "$actual" != "$expected" ]; then
                echo "unexpected deps build metadata: $actual" >&2
                exit 1
              fi
              printf '%s' "$actual" > "$out"
            '';
        checks.pure-eval-derived-workspace-root =
          pkgs.runCommand "mk-pnpm-cli-pure-eval-derived-workspace-root" { }
            ''
              actual='${
                builtins.toJSON (map (root: root.installDir) pureEvalDerivedWorkspaceFixture.passthru.installRoots)
              }'
              expected='[".","repos/effect-utils"]'
              if [ "$actual" != "$expected" ]; then
                echo "unexpected install roots for derived workspace root: $actual" >&2
                exit 1
              fi
              printf '%s' "$actual" > "$out"
            '';
        checks.pure-eval-profile-dedup = pkgs.runCommand "mk-pnpm-cli-pure-eval-profile-dedup" { } ''
          actual='${
            builtins.toJSON {
              externalSharedDeduped =
                profileDedupConsumerA.passthru.depsBuildsByInstallRoot."repos-effect-utils".drvPath
                == profileDedupConsumerB.passthru.depsBuildsByInstallRoot."repos-effect-utils".drvPath;
              rootDistinct =
                profileDedupConsumerA.passthru.depsBuildsByInstallRoot."root".drvPath
                != profileDedupConsumerB.passthru.depsBuildsByInstallRoot."root".drvPath;
            }
          }'
          expected='{"externalSharedDeduped":true,"rootDistinct":true}'
          if [ "$actual" != "$expected" ]; then
            echo "unexpected profile dedup result: $actual" >&2
            exit 1
          fi
          printf '%s' "$actual" > "$out"
        '';
        checks.pure-eval-dependency-materialization-evidence =
          pkgs.runCommand "mk-pnpm-cli-pure-eval-dependency-materialization-evidence" { }
            ''
              actual='${
                builtins.toJSON {
                  kind = pureEvalFixture.passthru.dependencyMaterializationEvidence.kind;
                  producer = pureEvalFixture.passthru.dependencyMaterializationEvidence.producer;
                  profileCount = builtins.length pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles;
                  attrNames = map (
                    profile: profile.attrName
                  ) pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles;
                  traits = map (
                    profile: profile.traits
                  ) pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles;
                  sourcePathInsensitive =
                    map (
                      profile: profile.profileKey
                    ) pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles
                    == map (
                      profile: profile.profileKey
                    ) pureEvalDerivedWorkspaceFixture.passthru.dependencyMaterializationEvidence.profiles;
                  consumerNameInsensitive =
                    (builtins.head profileDedupConsumerA.passthru.dependencyMaterializationEvidence.profiles).profileKey
                    == (builtins.head profileDedupConsumerB.passthru.dependencyMaterializationEvidence.profiles)
                    .profileKey;
                }
              }'
              expected='{"attrNames":["root","repos-effect-utils"],"consumerNameInsensitive":true,"kind":"dependency-materialization-evidence","producer":"effect-utils.mk-pnpm-cli","profileCount":2,"sourcePathInsensitive":true,"traits":[["nixPreparedDeps"],["nixPreparedDeps"]]}'
              if [ "$actual" != "$expected" ]; then
                echo "unexpected dependency materialization evidence: $actual" >&2
                exit 1
              fi
              printf '%s' "$actual" > "$out"
            '';
      }
    );
}
