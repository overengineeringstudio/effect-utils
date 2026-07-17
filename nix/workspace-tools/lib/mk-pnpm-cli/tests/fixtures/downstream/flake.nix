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
                  rootFreshnessInputs = builtins.sort builtins.lessThan (
                    builtins.attrNames (builtins.head pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles)
                    .freshness.manifestDigests
                  );
                  externalRootPatchAuthorityPresent = builtins.hasAttr "rootPatchedDependenciesSection" (builtins.elemAt pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles 1)
                  .freshness.rootPatchAuthority;
                  buck2Kind = pureEvalFixture.passthru.buck2DependencyMaterializationEvidence.kind;
                  buck2DoesNotOwnLive = lib.all (
                    materialization: materialization.ownsLiveMaterialization == false
                  ) pureEvalFixture.passthru.buck2DependencyMaterializationEvidence.materializations;
                  buck2EvidenceKeysMatch =
                    map (
                      materialization: materialization.evidenceKey
                    ) pureEvalFixture.passthru.buck2DependencyMaterializationEvidence.materializations
                    == map (
                      profile: profile.evidenceKey
                    ) pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles;
                  fodRepairKinds = map (target: target.kind) pureEvalFixture.passthru.fodHashRepairTargets;
                  fodRepairProfileKeysMatch =
                    map (target: target.profileKey) pureEvalFixture.passthru.fodHashRepairTargets
                    == map (
                      profile: profile.profileKey
                    ) pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles;
                  fodRepairHashPaths = map (target: target.hashPath) pureEvalFixture.passthru.fodHashRepairTargets;
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
                  absentOptionalInputsExcluded =
                    !(builtins.elem "pnpm-install-contract.json" (builtins.head pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles)
                    .inputs.manifests)
                    && !(builtins.elem "tsconfig.base.json" (builtins.head pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles)
                    .inputs.manifests);
                }
              }'
              expected='{"absentOptionalInputsExcluded":true,"attrNames":["root","repos-effect-utils"],"buck2DoesNotOwnLive":true,"buck2EvidenceKeysMatch":true,"buck2Kind":"buck2-dependency-materialization-evidence","consumerNameInsensitive":true,"externalRootPatchAuthorityPresent":true,"fodRepairHashPaths":[["depsBuilds",".","hash"],["depsBuilds","repos/effect-utils","hash"]],"fodRepairKinds":["dependency-fod-hash-repair-target","dependency-fod-hash-repair-target"],"fodRepairProfileKeysMatch":true,"kind":"dependency-materialization-evidence","producer":"effect-utils.mk-pnpm-cli","profileCount":2,"rootFreshnessInputs":[".npmrc","app/package.json","package.json","pnpm-lock.yaml","pnpm-workspace.yaml"],"sourcePathInsensitive":true,"traits":[["nixPreparedDeps"],["nixPreparedDeps"]]}'
              if [ "$actual" != "$expected" ]; then
                echo "unexpected dependency materialization evidence: $actual" >&2
                exit 1
              fi
              printf '%s' "$actual" > "$out"
            '';
        checks.prepared-workspace-injected-locator-identity =
          pkgs.runCommand "mk-pnpm-cli-prepared-workspace-injected-locator-identity"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
            }
            ''
              fixture="$PWD/fixture"
              mkdir -p \
                "$fixture/sources/alpha" \
                "$fixture/sources/bravo" \
                "$fixture/node_modules/.pnpm/same@file+sources+alpha/node_modules/@fixture/same" \
                "$fixture/node_modules/.pnpm/same@file+sources+bravo/node_modules/@fixture/same" \
                "$fixture/node_modules/.pnpm/same@file+sources+unlisted/node_modules/@fixture/same"

              cat > "$fixture/sources/alpha/package.json" <<'JSON'
              {"name":"@fixture/same","fixtureIdentity":"source-alpha"}
              JSON
              cat > "$fixture/sources/bravo/package.json" <<'JSON'
              {"name":"@fixture/same","fixtureIdentity":"source-bravo"}
              JSON
              cat > "$fixture/node_modules/.pnpm/same@file+sources+alpha/node_modules/@fixture/same/package.json" <<'JSON'
              {"name":"@fixture/same","fixtureIdentity":"materialized-alpha"}
              JSON
              cat > "$fixture/node_modules/.pnpm/same@file+sources+bravo/node_modules/@fixture/same/package.json" <<'JSON'
              {"name":"@fixture/same","fixtureIdentity":"materialized-bravo"}
              JSON
              cat > "$fixture/node_modules/.pnpm/same@file+sources+unlisted/node_modules/@fixture/same/package.json" <<'JSON'
              {"name":"@fixture/same","fixtureIdentity":"materialized-unlisted"}
              JSON
              cat > "$fixture/node_modules/.modules.yaml" <<'YAML'
              injectedDeps:
                sources/alpha:
                  - node_modules/.pnpm/same@file+sources+alpha/node_modules/@fixture/same
                sources/bravo:
                  - node_modules/.pnpm/same@file+sources+bravo/node_modules/@fixture/same
              layoutVersion: 5
              nodeLinker: isolated
              YAML

              (
                cd "$fixture"
                PREPARED_WORKSPACE_PLACEHOLDER=/__pnpm_prepared_workspace__ \
                  node ${pureEvalFixture.passthru.depsBuildsByInstallRoot.root.rewritePreparedWorkspaceScript}
              )

              alpha_target="$fixture/node_modules/.pnpm/same@file+sources+alpha/node_modules/@fixture/same"
              bravo_target="$fixture/node_modules/.pnpm/same@file+sources+bravo/node_modules/@fixture/same"
              unlisted_target="$fixture/node_modules/.pnpm/same@file+sources+unlisted/node_modules/@fixture/same"

              test -L "$alpha_target"
              test "$(readlink -f "$alpha_target")" = "$fixture/sources/alpha"
              test -L "$bravo_target"
              test "$(readlink -f "$bravo_target")" = "$fixture/sources/bravo"

              # A name/file+ directory scan would incorrectly rewrite this
              # same-name package despite pnpm not assigning it a source locator.
              test ! -L "$unlisted_target"
              grep -q 'materialized-unlisted' "$unlisted_target/package.json"

              touch "$out"
            '';
      }
    );
}
