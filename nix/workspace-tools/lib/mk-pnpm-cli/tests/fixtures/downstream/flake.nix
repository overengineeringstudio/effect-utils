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
        invalidSourceInputStagePathFixture = mkPnpmCli {
          name = "mk-pnpm-cli-invalid-source-input-stage-path-fixture";
          binaryName = "mk-pnpm-cli-invalid-source-input-stage-path-fixture";
          entry = "app/src/mod.ts";
          packageDir = "app";
          workspaceRoot = ./fixture-workspace-invalid-stage-path;
          depsBuilds = {
            "." = {
              hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
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
          "mk-pnpm-cli-pure-eval-root-deps" = pureEvalFixture.passthru.depsBuildsByInstallRoot.root;
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
        checks.prepared-source-input-manifest-aliases =
          pkgs.runCommand "mk-pnpm-cli-prepared-source-input-manifest-aliases" { }
            ''
              deps_src=${pureEvalFixture.passthru.depsSrcByInstallRoot.root}
              stage_prefix=.devenv/pnpm-source-inputs/current
              logical_path=repos/effect-utils/packages/@overeng/utils
              alias_path="$deps_src/$stage_prefix/$logical_path"

              grep -Fq "file:$stage_prefix/$logical_path" "$deps_src/pnpm-lock.yaml"
              grep -Fq "directory: $stage_prefix/$logical_path" "$deps_src/pnpm-lock.yaml"
              grep -Fq "file:$stage_prefix/$logical_path" "$deps_src/pnpm-workspace.yaml"
              grep -Fq "packageExtensionsChecksum: sha256-LU2/j/l3R+j7b1WqrjZQtPcw3ScrfwaVJrrAFedVGTs=" \
                "$deps_src/pnpm-lock.yaml"
              test -d "$alias_path"
              test "$(find "$alias_path" -mindepth 1 -maxdepth 1 -printf '%f\n')" = package.json
              test -L "$alias_path/package.json"
              test "$(realpath "$alias_path/package.json")" = "$deps_src/$logical_path/package.json"
              cmp "$alias_path/package.json" "$deps_src/$logical_path/package.json"
              test ! -e "$alias_path/src"

              grep -Fq "\"sourceInputStagePath\": \"$stage_prefix\"" \
                "$deps_src/pnpm-install-contract.json"
              touch "$out"
            '';
        checks.invalid-source-input-stage-path =
          let
            evaluation = builtins.tryEval invalidSourceInputStagePathFixture.passthru.depsSrcByInstallRoot.root.drvPath;
          in
          assert !evaluation.success;
          pkgs.runCommand "mk-pnpm-cli-invalid-source-input-stage-path" { } ''
            touch "$out"
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
                  sourceInputContractIncluded = builtins.elem "pnpm-install-contract.json" (builtins.head pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles)
                  .inputs.manifests;
                  absentOptionalInputsExcluded =
                    !(builtins.elem "tsconfig.base.json" (builtins.head pureEvalFixture.passthru.dependencyMaterializationEvidence.profiles)
                    .inputs.manifests);
                }
              }'
              expected='{"absentOptionalInputsExcluded":true,"attrNames":["root","repos-effect-utils"],"buck2DoesNotOwnLive":true,"buck2EvidenceKeysMatch":true,"buck2Kind":"buck2-dependency-materialization-evidence","consumerNameInsensitive":true,"externalRootPatchAuthorityPresent":true,"fodRepairHashPaths":[["depsBuilds",".","hash"],["depsBuilds","repos/effect-utils","hash"]],"fodRepairKinds":["dependency-fod-hash-repair-target","dependency-fod-hash-repair-target"],"fodRepairProfileKeysMatch":true,"kind":"dependency-materialization-evidence","producer":"effect-utils.mk-pnpm-cli","profileCount":2,"rootFreshnessInputs":[".npmrc","app/package.json","package.json","pnpm-install-contract.json","pnpm-lock.yaml","pnpm-workspace.yaml"],"sourceInputContractIncluded":true,"sourcePathInsensitive":true,"traits":[["nixPreparedDeps"],["nixPreparedDeps"]]}'
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
        checks.prepared-workspace-source-input-file-links =
          pkgs.runCommand "mk-pnpm-cli-prepared-workspace-source-input-file-links"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
            }
            ''
              fixture="$PWD/fixture"
              logical_path=repos/effect-utils/packages/@overeng/utils
              wrong_logical_path=repos/effect-utils/packages/@overeng/wrong-utils
              locator='@overeng/utils@file:.devenv/pnpm-source-inputs/current/repos/effect-utils/packages/@overeng/utils(effect@3.21.4)(react-dom@19.2.4)(react@19.2.4)'
              virtual_path='.pnpm/@overeng+utils@file+.devenv+pnpm-source-inputs+current+repos+effect-utils+packages+@overeng+utils/node_modules/@overeng/utils'
              mkdir -p \
                "$fixture/$logical_path/src" \
                "$fixture/$wrong_logical_path" \
                "$fixture/.devenv/pnpm-source-inputs/current/$logical_path" \
                "$fixture/node_modules/$virtual_path/node_modules/effect" \
                "$fixture/node_modules/@overeng"

              cat > "$fixture/$logical_path/package.json" <<'JSON'
              {"name":"@overeng/utils","exports":{"./node/example":"./src/example.js"}}
              JSON
              cat > "$fixture/$logical_path/src/example.js" <<'JS'
              export const example = true
              JS
              cat > "$fixture/$wrong_logical_path/package.json" <<'JSON'
              {"name":"@overeng/wrong-utils"}
              JSON
              touch "$fixture/node_modules/$virtual_path/node_modules/effect/retained-dependency"
              ln -s "$(realpath --relative-to="$fixture/.devenv/pnpm-source-inputs/current/$logical_path" "$fixture/$wrong_logical_path/package.json")" \
                "$fixture/.devenv/pnpm-source-inputs/current/$logical_path/package.json"
              cat > "$fixture/node_modules/.package-map.json" <<JSON
              {"packages":{"$locator":{"url":"./$virtual_path"}}}
              JSON
              cat > "$fixture/node_modules/.modules.yaml" <<'JSON'
              {"injectedDeps":{}}
              JSON
              ln -s "../$virtual_path" "$fixture/node_modules/@overeng/utils"

              if (cd "$fixture" && PREPARED_WORKSPACE_PLACEHOLDER=/__pnpm_prepared_workspace__ \
                node ${pureEvalFixture.passthru.depsBuildsByInstallRoot.root.rewritePreparedWorkspaceScript}) 2> "$fixture/wrong-alias.log"; then
                echo "expected a mismatched source-input alias to fail" >&2
                exit 1
              fi
              grep -q 'does not select its declared logical manifest' "$fixture/wrong-alias.log"
              rm "$fixture/.devenv/pnpm-source-inputs/current/$logical_path/package.json"
              ln -s "$(realpath --relative-to="$fixture/.devenv/pnpm-source-inputs/current/$logical_path" "$fixture/$logical_path/package.json")" \
                "$fixture/.devenv/pnpm-source-inputs/current/$logical_path/package.json"

              outside_dir="$PWD/outside"
              mkdir -p "$outside_dir"
              mv "$fixture/$logical_path/package.json" "$outside_dir/package.json"
              ln -s "$outside_dir/package.json" "$fixture/$logical_path/package.json"
              if (cd "$fixture" && PREPARED_WORKSPACE_PLACEHOLDER=/__pnpm_prepared_workspace__ \
                node ${pureEvalFixture.passthru.depsBuildsByInstallRoot.root.rewritePreparedWorkspaceScript}) 2> "$fixture/escaping-source.log"; then
                echo "expected an escaping logical source to fail" >&2
                exit 1
              fi
              grep -q 'resolved outside prepared workspace' "$fixture/escaping-source.log"
              rm "$fixture/$logical_path/package.json"
              mv "$outside_dir/package.json" "$fixture/$logical_path/package.json"

              (cd "$fixture" && PREPARED_WORKSPACE_PLACEHOLDER=/__pnpm_prepared_workspace__ \
                node ${pureEvalFixture.passthru.depsBuildsByInstallRoot.root.rewritePreparedWorkspaceScript})

              package_target="$fixture/node_modules/$virtual_path"
              test -L "$package_target"
              test -f "$package_target/package.json"
              test -f "$package_target/src/example.js"
              test "$(realpath "$package_target")" = "$(realpath "$fixture/$logical_path")"
              rm -rf "$fixture/.devenv"
              test -f "$package_target/src/example.js"

              touch "$out"
            '';
      }
    );
}
