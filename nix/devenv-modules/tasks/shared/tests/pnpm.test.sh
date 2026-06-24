#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
HELPERS_SCRIPT="$ROOT/nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh"
PROJECTION_SCRIPT="$ROOT/nix/devenv-modules/tasks/shared/check-node-modules-projection-health.cjs"

# The unit-style shell tests should execute the same helper implementations as
# the generated task scripts so they catch real regressions instead of drift in
# duplicated test-only copies.
source "$HELPERS_SCRIPT"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
    exit 1
  fi
}

assert_json_field() {
  local expected="$1"
  local file="$2"
  local expression="$3"
  local label="$4"

  local actual
  actual="$(node -e "const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const out = (${expression})(value); process.stdout.write(String(out))" "$file")"
  assert_eq "$expected" "$actual" "$label"
}

make_projection_fixture() {
  local root="$1"
  local with_dep="$2"
  local dep_blocks_package_json_export="${3:-0}"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","dependencies":{"dep":"1.0.0"}}
EOF
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"

  if [ "$with_dep" = "1" ]; then
    mkdir -p "$package_root/node_modules/dep"
    if [ "$dep_blocks_package_json_export" = "1" ]; then
      cat > "$package_root/node_modules/dep/package.json" <<'EOF'
{"name":"dep","exports":{".":"./index.js"}}
EOF
      cat > "$package_root/node_modules/dep/index.js" <<'EOF'
module.exports = {}
EOF
    else
      cat > "$package_root/node_modules/dep/package.json" <<'EOF'
{"name":"dep"}
EOF
    fi
  fi
}

make_source_link_fixture() {
  local root="$1"

  mkdir -p "$root/source/pkg"
  mkdir -p "$root/node_modules"
  cat > "$root/source/pkg/package.json" <<'EOF'
{"name":"pkg","dependencies":{"dep":"1.0.0"}}
EOF
  ln -s ../source/pkg "$root/node_modules/pkg"
}

make_missing_export_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["src"],"exports":{".":{"default":"./src/index.js"}}}
EOF
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_unshipped_conditional_export_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root/dist"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"exports":{".":{"custom-condition":"./src/index.ts","default":"./dist/index.js"}}}
EOF
  touch "$package_root/dist/index.js"
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_missing_conditional_export_alternative_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root/build"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["build"],"main":"./build/pkg.esm.js","exports":{".":{"import":"./build/pkg.esm.js","require":"./build/index.js","browser":"./build/pkg.min.js"}}}
EOF
  touch "$package_root/build/pkg.esm.js"
  touch "$package_root/build/pkg.min.js"
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_missing_type_export_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root/dist"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"exports":{"./internal/module-runner":{"types":"./dist/module-runner.d.ts","default":"./dist/module-runner.js"}}}
EOF
  touch "$package_root/dist/module-runner.js"
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_builtin_dependency_fixture() {
  local root="$1"

  mkdir -p "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"
  mkdir -p "$root/node_modules"
  cat > "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/package.json" <<'EOF'
{"name":"pkg","dependencies":{"buffer":"^5.0.0","node:test":"^1.0.0"}}
EOF
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"
}

make_extensionless_main_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root/lib"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["lib"],"main":"./lib/index","exports":{".":{"default":"./lib/index"}}}
EOF
  touch "$package_root/lib/index.js"
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_missing_subpath_export_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root/dist"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"main":"./dist/index.js","exports":{".":{"default":"./dist/index.js"},"./optional":{"default":"./dist/optional.js"}}}
EOF
  touch "$package_root/dist/index.js"
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_bin_fixture() {
  local root="$1"

  mkdir -p "$root/node_modules/fake-tool/bin" "$root/node_modules/.bin"
  cat > "$root/node_modules/fake-tool/package.json" <<'EOF'
{"name":"fake-tool","bin":{"fake-tool":"bin/fake-tool.js","alt-tool":"bin/fake-tool.js"}}
EOF
  cat > "$root/node_modules/fake-tool/bin/fake-tool.js" <<'EOF'
#!/usr/bin/env node
process.stdout.write(`fake-tool-direct:${process.argv.slice(2).join(',')}\n`)
EOF
  chmod +x "$root/node_modules/fake-tool/bin/fake-tool.js"
  cat > "$root/node_modules/.bin/fake-tool" <<'EOF'
#!/usr/bin/env bash
printf 'fake-tool-shim:%s\n' "$*"
EOF
  chmod +x "$root/node_modules/.bin/fake-tool"
}

make_bin_fixture_without_shim() {
  local root="$1"

  mkdir -p "$root/node_modules/fallback-tool/bin"
  cat > "$root/node_modules/fallback-tool/package.json" <<'EOF'
{"name":"fallback-tool","bin":{"fallback-tool":"bin/fallback-tool.js"}}
EOF
  cat > "$root/node_modules/fallback-tool/bin/fallback-tool.js" <<'EOF'
#!/usr/bin/env node
process.stdout.write(`fallback-tool-direct:${process.argv.slice(2).join(',')}\n`)
EOF
  chmod +x "$root/node_modules/fallback-tool/bin/fallback-tool.js"
}

echo "Running pnpm task helper tests..."
echo ""

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

echo "Test 1: explicit store-dir takes precedence for GVS links path"
mkdir -p "$test_dir/pnpm-store/v11" "$test_dir/pnpm-home/store/v11" "$test_dir/xdg/pnpm/store/v11" "$test_dir/home/.local/share/pnpm/store/v11"
(
  export HOME="$test_dir/home"
  export npm_config_store_dir="$test_dir/pnpm-store"
  export PNPM_STORE_DIR="$test_dir/ignored-pnpm-store"
  export PNPM_HOME="$test_dir/pnpm-home"
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/pnpm-store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir prefers npm_config_store_dir"
)

echo "Test 2: PNPM_STORE_DIR is used when npm_config_store_dir is unset"
(
  export HOME="$test_dir/home"
  unset npm_config_store_dir
  export PNPM_STORE_DIR="$test_dir/pnpm-store"
  export PNPM_HOME="$test_dir/pnpm-home"
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/pnpm-store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir uses PNPM_STORE_DIR"
)

echo "Test 3: PNPM_HOME is used when store-dir is unset"
(
  export HOME="$test_dir/home"
  unset npm_config_store_dir
  unset PNPM_STORE_DIR
  export PNPM_HOME="$test_dir/pnpm-home"
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/pnpm-home/store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir falls back to PNPM_HOME"
)

echo "Test 4: XDG_DATA_HOME is used when PNPM_HOME is unset"
(
  export HOME="$test_dir/home"
  unset npm_config_store_dir
  unset PNPM_STORE_DIR
  unset PNPM_HOME
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/xdg/pnpm/store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir uses XDG_DATA_HOME"
)

echo "Test 5: ensure_local_pnpm_home_default sets a workspace-local default"
(
  unset PNPM_HOME
  ensure_local_pnpm_home_default "$test_dir/workspace"
  assert_eq \
    "$test_dir/workspace/.pnpm-home" \
    "$PNPM_HOME" \
    "ensure_local_pnpm_home_default sets PNPM_HOME"
)

echo "Test 6: ensure_local_pnpm_home_default preserves an explicit PNPM_HOME"
(
  export PNPM_HOME="$test_dir/custom-home"
  ensure_local_pnpm_home_default "$test_dir/workspace"
  assert_eq \
    "$test_dir/custom-home" \
    "$PNPM_HOME" \
    "ensure_local_pnpm_home_default keeps explicit PNPM_HOME"
)

echo "Test 7: Cache fingerprint changes when GVS path changes"
fingerprint_a="$(cache_fingerprint "workspace-hash" "/tmp/a/store/v11/links")"
fingerprint_b="$(cache_fingerprint "workspace-hash" "/tmp/b/store/v11/links")"
if [ "$fingerprint_a" = "$fingerprint_b" ]; then
  echo "FAIL: cache fingerprint should change when GVS path changes"
  exit 1
fi

echo "Test 8: resolve_pnpm_install_contract_file walks up to the repo contract"
contract_fixture="$test_dir/contract-fixture"
mkdir -p "$contract_fixture/packages/app"
printf '{"schemaVersion":1}\n' > "$contract_fixture/pnpm-install-contract.json"
assert_eq \
  "$contract_fixture/pnpm-install-contract.json" \
  "$(resolve_pnpm_install_contract_file "$contract_fixture/packages/app")" \
  "resolve_pnpm_install_contract_file finds ancestor contract"

echo "Test 9: pnpm contract section hashing is stable across JSON key order"
contract_a="$test_dir/contract-a.json"
contract_b="$test_dir/contract-b.json"
cat > "$contract_a" <<'EOF'
{"schemaVersion":1,"gvsLinkContract":{"packageExtensions":{"storybook":{"dependencies":{"@storybook/react-vite":"10.4.6"}}},"allowBuilds":{"esbuild":false}}}
EOF
cat > "$contract_b" <<'EOF'
{"gvsLinkContract":{"allowBuilds":{"esbuild":false},"packageExtensions":{"storybook":{"dependencies":{"@storybook/react-vite":"10.4.6"}}}},"schemaVersion":1}
EOF
assert_eq \
  "$(compute_pnpm_contract_section_hash node "$contract_a" gvsLinkContract)" \
  "$(compute_pnpm_contract_section_hash node "$contract_b" gvsLinkContract)" \
  "contract section hash ignores JSON object key order"

echo "Test 10: policy-only contract changes do not classify as GVS link drift"
contract_policy_old="$test_dir/contract-policy-old.json"
contract_policy_new="$test_dir/contract-policy-new.json"
cat > "$contract_policy_old" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "gvsLinkContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"enableGlobalVirtualStore": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"fixedOutputDependencyPrepUsesLiveGlobalVirtualStore": false},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
cat > "$contract_policy_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "gvsLinkContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"enableGlobalVirtualStore": false},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"fixedOutputDependencyPrepUsesLiveGlobalVirtualStore": false},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "policy" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_policy_new")" \
  "policy-only contract changes are not gvs-link changes"

echo "Test 11: packageExtensions changes classify as GVS link drift"
contract_gvs_new="$test_dir/contract-gvs-new.json"
cat > "$contract_gvs_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "gvsLinkContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {"storybook": {"dependencies": {"@storybook/react-vite": "10.4.6"}}}},
  "installPolicy": {"enableGlobalVirtualStore": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"fixedOutputDependencyPrepUsesLiveGlobalVirtualStore": false},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "gvs-link" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_gvs_new")" \
  "packageExtensions changes are gvs-link changes"

echo "Test 12: unchanged classified sections report an unknown miss reason"
contract_unknown_new="$test_dir/contract-unknown-new.json"
cat > "$contract_unknown_new" <<'EOF'
{
  "schemaVersion": 2,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "gvsLinkContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"enableGlobalVirtualStore": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"fixedOutputDependencyPrepUsesLiveGlobalVirtualStore": true},
  "buck2Integration": {"consumeContractArtifact": false}
}
EOF
assert_eq \
  "unknown" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_unknown_new")" \
  "unclassified contract changes return unknown"

echo "Test 13: package manager changes classify as toolchain drift"
contract_toolchain_new="$test_dir/contract-toolchain-new.json"
cat > "$contract_toolchain_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.9.0"},
  "gvsLinkContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"enableGlobalVirtualStore": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"fixedOutputDependencyPrepUsesLiveGlobalVirtualStore": false},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "toolchain" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_toolchain_new")" \
  "package manager changes classify as toolchain"

echo "Test 14: store contract changes classify as store drift"
contract_store_new="$test_dir/contract-store-new.json"
cat > "$contract_store_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "gvsLinkContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"enableGlobalVirtualStore": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v2"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "nixIntegration": {"fixedOutputDependencyPrepUsesLiveGlobalVirtualStore": false},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "store" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_store_new")" \
  "store contract changes classify as store"

echo "Test 15: workspace manifest contract changes classify as manifest/config drift"
contract_manifest_new="$test_dir/contract-manifest-new.json"
cat > "$contract_manifest_new" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "gvsLinkContract": {"allowBuilds": {"esbuild": false}, "packageExtensions": {}},
  "installPolicy": {"enableGlobalVirtualStore": true},
  "storeContract": {"storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app", "packages/lib"]},
  "nixIntegration": {"fixedOutputDependencyPrepUsesLiveGlobalVirtualStore": false},
  "buck2Integration": {"consumeContractArtifact": true}
}
EOF
assert_eq \
  "manifest_config" \
  "$(classify_pnpm_contract_change node "$contract_policy_old" "$contract_manifest_new")" \
  "workspace manifest contract changes classify as manifest_config"

echo "Test 16: missing contract sections fail section hashing"
contract_missing="$test_dir/contract-missing-section.json"
cat > "$contract_missing" <<'EOF'
{"schemaVersion":1}
EOF
set +e
compute_pnpm_contract_section_hash node "$contract_missing" gvsLinkContract >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "missing section hash should fail"

echo "Test 16a: dependency materialization profile emission is stable and trait-aware"
contract_profile="$test_dir/contract-profile.json"
profile_output="$test_dir/profile.json"
cat > "$contract_profile" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "gvsLinkContract": {"allowBuilds": {}, "packageExtensions": {}, "packageManager": {"name": "pnpm", "version": "11.8.0"}},
  "installPolicy": {"ignoreScripts": true, "verifyStoreIntegrity": true},
  "storeContract": {"owner": "pnpm", "layoutVersion": "v11", "storeDir": ".devenv/pnpm-store-pure-v1"},
  "workspaceManifestContract": {"packages": ["packages/app"]},
  "dependencyMaterializationProfile": {
    "schema": "dependency-materialization-profile/v0",
    "identityInputs": ["packageManager", "gvsLinkContract", "installPolicy", "storeContract", "workspaceManifestContract"],
    "supportedTraits": {
      "darwinSplitCas": {
        "mutableState": "profile-local",
        "sharedContent": "store/v11/files",
        "gcAuthority": "shared-pool-coordinator",
        "repairAuthority": "devenv"
      },
      "isolated": {
        "mutableState": "profile-local",
        "gcAuthority": "profile-local",
        "repairAuthority": "devenv"
      }
    },
    "nativeBuildPolicyInputs": {
      "allowBuilds": "gvsLinkContract.allowBuilds",
      "compilerEnv": ["CC", "CXX"]
    }
  }
}
EOF
emit_dependency_materialization_profile node "$contract_profile" darwinSplitCas "$profile_output"
node - "$profile_output" <<'EOF'
const fs = require('node:fs')
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (profile.schema !== 'dependency-materialization-profile/v0') throw new Error('schema drift')
if (!profile.profileId.startsWith('pnpm:')) throw new Error('missing pnpm profile id prefix')
if (profile.store.trait !== 'darwinSplitCas') throw new Error('wrong store trait')
if (profile.authorities.gc !== 'shared-pool-coordinator') throw new Error('wrong gc authority')
if (profile.authorities.repair !== 'devenv') throw new Error('wrong repair authority')
if (!profile.policy.nativeBuildPolicyInputs.compilerEnv.includes('CXX')) throw new Error('missing native compiler policy')
if (profile.evidence.sectionDigests.storeContract.length !== 64) throw new Error('missing section digest')
if (profile.evidence.contractPath.startsWith('/')) throw new Error('contract path should be relative')
EOF
pnpm_contract_supports_dependency_materialization_profile node "$contract_profile"
set +e
pnpm_contract_supports_dependency_materialization_profile node "$contract_missing" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "old contract should not require dependency materialization evidence"
set +e
emit_dependency_materialization_profile node "$contract_profile" unknownTrait >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "unsupported profile trait should fail"

echo "Test 16b: dependency materialization doctor refuses shared pools and plans coordinated repair"
doctor_root="$test_dir/profile-doctor"
mkdir -p "$doctor_root/profile-a-store/v11" "$doctor_root/profile-b-store/v11" "$doctor_root/shared-files/v11" "$doctor_root/isolated-store/v11/files"
ln -s "$doctor_root/shared-files/v11" "$doctor_root/profile-a-store/v11/files"
ln -s "$doctor_root/shared-files/v11" "$doctor_root/profile-b-store/v11/files"
registry_file="$doctor_root/registry.json"
cat > "$registry_file" <<EOF
{
  "profiles": [
    {"id": "profile-a", "filesPoolId": "shared", "project": "$doctor_root/work-a", "store": "$doctor_root/profile-a-store"},
    {"id": "profile-b", "filesPoolId": "shared", "project": "$doctor_root/work-b", "store": "$doctor_root/profile-b-store"},
    {"id": "profile-c", "filesPoolId": "isolated", "project": "$doctor_root/work-c", "store": "$doctor_root/isolated-store"}
  ],
  "pools": [
    {"id": "shared", "filesPath": "$doctor_root/profile-a-store/v11/files"},
    {"id": "isolated", "filesPath": "$doctor_root/isolated-store/v11/files"}
  ]
}
EOF
shared_decision="$(dependency_materialization_store_doctor node "$registry_file" profile-a | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).decision)')"
assert_eq "refuse-raw-prune" "$shared_decision" "shared files pool refuses raw prune"
isolated_decision="$(dependency_materialization_store_doctor node "$registry_file" profile-c | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).decision)')"
assert_eq "allow-profile-local-prune" "$isolated_decision" "isolated files pool allows profile-local prune"
repair_decision="$(dependency_materialization_repair_plan node "$registry_file" shared | node -e 'const fs=require("node:fs"); const plan=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(`${plan.decision}:${plan.roots.length}`)')"
assert_eq "repair-all-roots:2" "$repair_decision" "shared files pool repair covers all registered roots"

echo "Test 16c: dependency materialization registry records live profile and files pool"
registry_root="$test_dir/profile-registry"
mkdir -p "$registry_root/store/v11" "$registry_root/second-store/v11" "$registry_root/shared-files/v11" "$registry_root/workspace" "$registry_root/second-workspace"
ln -s "$registry_root/shared-files/v11" "$registry_root/store/v11/files"
ln -s "$registry_root/shared-files/v11" "$registry_root/second-store/v11/files"
live_registry="$registry_root/registry.json"
shared_registry="$(dependency_materialization_shared_registry_file node "$registry_root/store")"
write_dependency_materialization_registry node "$profile_output" "$registry_root/workspace" "$registry_root/store" "$live_registry" "$shared_registry"
registry_profile_id="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).profileId)' "$profile_output")"
assert_json_field \
  "dependency-materialization-registry/v0" \
  "$live_registry" \
  "value => value.schema" \
  "registry schema"
assert_json_field \
  "$registry_profile_id" \
  "$live_registry" \
  "value => value.profiles[0].profileId" \
  "registry profile id"
assert_json_field \
  "refuse-raw-prune" \
  <(dependency_materialization_store_doctor node "$live_registry" "$registry_profile_id") \
  "value => value.decision" \
  "registry shared pool doctor decision"
second_registry="$registry_root/second-registry.json"
write_dependency_materialization_registry node "$profile_output" "$registry_root/second-workspace" "$registry_root/second-store" "$second_registry" "$shared_registry"
assert_json_field \
  "2" \
  "$second_registry" \
  "value => value.profiles.length" \
  "shared registry aggregates sibling roots with the same dependency profile"
assert_eq \
  "2" \
  "$(dependency_materialization_repair_roots node "$second_registry" "$(dependency_materialization_profile_files_pool_id node "$second_registry" "$registry_profile_id")" | wc -l | tr -d ' ')" \
  "repair roots include every workspace sharing the files pool"
discovered_profile_store_dir="$(dependency_materialization_profile_store_dir node "$second_registry" "$registry_profile_id")"
case "$discovered_profile_store_dir" in
  "$registry_root/store" | "$registry_root/second-store") ;;
  *)
    echo "FAIL: profile store dir is discoverable for shared registry refresh"
    echo "  actual: $discovered_profile_store_dir"
    exit 1
    ;;
esac
stale_local_registry="$registry_root/stale-local-registry.json"
write_dependency_materialization_registry node "$profile_output" "$registry_root/workspace" "$registry_root/store" "$stale_local_registry"
assert_eq \
  "2" \
  "$(dependency_materialization_repair_roots node "$shared_registry" "$(dependency_materialization_profile_files_pool_id node "$stale_local_registry" "$registry_profile_id")" | wc -l | tr -d ' ')" \
  "shared registry carries sibling roots missing from stale local registry"
changed_profile="$registry_root/changed-profile.json"
node -e 'const fs=require("node:fs"); const profile=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); profile.profileId += ":changed"; fs.writeFileSync(process.argv[2], JSON.stringify(profile, null, 2) + "\n")' "$profile_output" "$changed_profile"
write_dependency_materialization_registry node "$changed_profile" "$registry_root/workspace" "$registry_root/store" "$live_registry" "$shared_registry"
assert_json_field \
  "2" \
  "$shared_registry" \
  "value => value.profiles.length" \
  "changed profile replaces existing root row instead of adding duplicate sibling"

echo "Test 17: resolve_package_bin prefers package-local .bin shims"
bin_fixture="$test_dir/bin-fixture"
make_bin_fixture "$bin_fixture"
resolved_bin="$(resolve_package_bin fake-tool fake-tool "$bin_fixture")"
expected_bin="$bin_fixture/node_modules/.bin/fake-tool"
assert_eq \
  "$expected_bin" \
  "$resolved_bin" \
  "resolve_package_bin prefers the generated .bin shim"

echo "Test 18: run_package_bin executes the .bin shim when present"
output="$(cd "$bin_fixture" && run_package_bin fake-tool fake-tool alpha beta)"
assert_eq \
  "fake-tool-shim:alpha beta" \
  "$output" \
  "run_package_bin executes the resolved shim"

echo "Test 19: resolve_package_bin falls back to the package bin file"
fallback_fixture="$test_dir/fallback-bin-fixture"
make_bin_fixture_without_shim "$fallback_fixture"
resolved_fallback_bin="$(resolve_package_bin fallback-tool fallback-tool "$fallback_fixture")"
expected_fallback_bin="$(cd "$fallback_fixture/node_modules/fallback-tool/bin" && pwd -P)/fallback-tool.js"
assert_eq \
  "$expected_fallback_bin" \
  "$resolved_fallback_bin" \
  "resolve_package_bin falls back to the package bin file"

echo "Test 20: Projection health passes when symlinked package can resolve deps"
healthy_dir="$test_dir/healthy"
make_projection_fixture "$healthy_dir" 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$healthy_dir/node_modules"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health passes"

echo "Test 21: Projection health ignores packages that do not export ./package.json"
exports_dir="$test_dir/exports"
make_projection_fixture "$exports_dir" 1 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$exports_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health should not depend on package.json exports"

echo "Test 22: Projection health fails when symlinked package loses a transitive dep"
stale_dir="$test_dir/stale"
make_projection_fixture "$stale_dir" 0
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$stale_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health detects missing dep"

echo "Test 23: Projection health does not require source link deps to resolve"
source_link_dir="$test_dir/source-link"
make_source_link_fixture "$source_link_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$source_link_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health skips source link dependency resolution"

echo "Test 24: Broken node_modules symlink is rejected before projection checks"
broken_dir="$test_dir/broken"
mkdir -p "$broken_dir/node_modules"
ln -s ../missing "$broken_dir/node_modules/broken"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$broken_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "broken symlink is rejected"

echo "Test 25: Projection health fails when a package export target is missing"
missing_export_dir="$test_dir/missing-export"
make_missing_export_fixture "$missing_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health detects missing package export target"

echo "Test 26: Projection health ignores unshipped conditional export targets"
unshipped_export_dir="$test_dir/unshipped-export"
make_unshipped_conditional_export_fixture "$unshipped_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$unshipped_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores export targets outside package files"

echo "Test 27: Projection health ignores missing declaration-only export targets"
missing_type_dir="$test_dir/missing-type-export"
make_missing_type_export_fixture "$missing_type_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_type_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores type-only export targets"

echo "Test 28: Projection health accepts a package when one root conditional export target exists"
missing_condition_alternative_dir="$test_dir/missing-condition-alternative"
make_missing_conditional_export_alternative_fixture "$missing_condition_alternative_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_condition_alternative_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health accepts alternate runtime export targets"

echo "Test 29: Projection health ignores dependency names that Node resolves as built-ins"
builtin_dependency_dir="$test_dir/builtin-dependency"
make_builtin_dependency_fixture "$builtin_dependency_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$builtin_dependency_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores built-in dependency names"

echo "Test 30: Projection health accepts extensionless main and root export targets"
extensionless_main_dir="$test_dir/extensionless-main"
make_extensionless_main_fixture "$extensionless_main_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$extensionless_main_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health accepts extensionless runtime targets"

echo "Test 31: Projection health ignores missing optional subpath export targets"
missing_subpath_export_dir="$test_dir/missing-subpath-export"
make_missing_subpath_export_fixture "$missing_subpath_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_subpath_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores optional subpath exports"

echo "Test 32: dependency materialization profile is stable for identical contracts"
profile_contract="$test_dir/profile-contract.json"
cat > "$profile_contract" <<'EOF'
{
  "schemaVersion": 1,
  "packageManager": {"name": "pnpm", "version": "11.8.0"},
  "storeContract": {
    "owner": "pnpm",
    "layoutVersion": "v11",
    "storeDir": ".devenv/pnpm-store-pure-v1",
    "sharedFilesStore": {"enabledForLocalDev": true, "disabledInCi": true},
    "globalVirtualStore": {"enabled": true}
  },
  "gvsLinkContract": {
    "packageManager": {"name": "pnpm", "version": "11.8.0"},
    "allowBuilds": {"esbuild": false},
    "packageExtensions": {}
  },
  "installPolicy": {
    "ignoreScripts": true,
    "packageImportMethod": "clone-or-copy",
    "verifyStoreIntegrity": true
  },
  "workspaceManifestContract": {
    "injectWorkspacePackages": true,
    "packages": ["packages/app", "packages/lib"],
    "patchedDependencies": {}
  },
  "dependencyMaterializationProfile": {
    "schema": "dependency-materialization-profile/v0",
    "identityInputs": [
      "packageManager",
      "gvsLinkContract",
      "installPolicy",
      "storeContract",
      "workspaceManifestContract"
    ],
    "supportedTraits": {
      "darwinSplitCas": {
        "mutableState": "profile-local",
        "sharedContent": "store/v11/files",
        "gcAuthority": "shared-pool-coordinator",
        "repairAuthority": "devenv"
      },
      "isolated": {
        "mutableState": "profile-local",
        "gcAuthority": "profile-local",
        "repairAuthority": "devenv"
      }
    },
    "nativeBuildPolicyInputs": {
      "allowBuilds": "gvsLinkContract.allowBuilds",
      "compilerEnv": ["CC", "CXX"]
    }
  }
}
EOF
profile_a="$test_dir/profile-a.json"
profile_b="$test_dir/profile-b.json"
emit_dependency_materialization_profile node "$profile_contract" darwinSplitCas "$profile_a"
emit_dependency_materialization_profile node "$profile_contract" darwinSplitCas "$profile_b"
assert_eq \
  "$(compute_hash < "$profile_a")" \
  "$(compute_hash < "$profile_b")" \
  "dependency profile output is stable"
assert_json_field \
  "shared-pool-coordinator" \
  "$profile_a" \
  "(value) => value.authorities.gc" \
  "dependency profile records gc authority"

echo "Test 33: source-only files are not dependency profile identity inputs"
mkdir -p "$test_dir/profile-source/packages/app/src"
cp "$profile_contract" "$test_dir/profile-source/pnpm-install-contract.json"
echo "export const value = 1" > "$test_dir/profile-source/packages/app/src/index.ts"
(
  cd "$test_dir/profile-source"
  emit_dependency_materialization_profile node pnpm-install-contract.json darwinSplitCas profile-before.json
  echo "export const value = 2" > packages/app/src/index.ts
  emit_dependency_materialization_profile node pnpm-install-contract.json darwinSplitCas profile-after.json
  assert_json_field \
    "$(node -e "const fs = require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync('profile-before.json','utf8')).profileId)")" \
    profile-after.json \
    "(value) => value.profileId" \
    "source-only mutations do not affect dependency profile identity"
)

echo "Test 34: manifest contract changes dependency profile identity"
manifest_contract="$test_dir/profile-contract-manifest-change.json"
node - "$profile_contract" "$manifest_contract" <<'EOF'
const fs = require('node:fs')
const [from, to] = process.argv.slice(2)
const contract = JSON.parse(fs.readFileSync(from, 'utf8'))
contract.workspaceManifestContract.packages.push('packages/new-member')
fs.writeFileSync(to, `${JSON.stringify(contract, null, 2)}\n`)
EOF
profile_manifest="$test_dir/profile-manifest.json"
emit_dependency_materialization_profile node "$manifest_contract" darwinSplitCas "$profile_manifest"
if [ "$(node -e "const fs = require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).profileId)" "$profile_a")" = "$(node -e "const fs = require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).profileId)" "$profile_manifest")" ]; then
  echo "FAIL: manifest contract changes dependency profile identity"
  exit 1
fi

echo "Test 35: unknown dependency materialization trait fails closed"
set +e
emit_dependency_materialization_profile node "$profile_contract" unknownTrait >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "unknown store trait should fail"

echo "Test 36: store doctor refuses raw prune of a shared files pool"
doctor_registry="$test_dir/doctor-registry.json"
shared_files="$test_dir/shared-files/v11"
shared_root="$test_dir/profile-a/store/v11"
mkdir -p "$shared_files" "$shared_root"
ln -s "$shared_files" "$shared_root/files"
cat > "$doctor_registry" <<EOF
{
  "profiles": [
    {"id": "profile-a", "project": "a", "store": "$test_dir/profile-a/store", "filesPoolId": "pool-shared"},
    {"id": "profile-b", "project": "b", "store": "$test_dir/profile-b/store", "filesPoolId": "pool-shared"}
  ],
  "pools": [
    {"id": "pool-shared", "filesPath": "$shared_root/files"}
  ]
}
EOF
doctor_shared="$test_dir/doctor-shared.json"
dependency_materialization_store_doctor node "$doctor_registry" profile-a > "$doctor_shared"
assert_json_field \
  "refuse-raw-prune" \
  "$doctor_shared" \
  "(value) => value.decision" \
  "shared pool raw prune is refused"
assert_json_field \
  "profile-a,profile-b" \
  "$doctor_shared" \
  "(value) => value.siblings.join(',')" \
  "shared pool doctor reports sibling profiles"

echo "Test 37: store doctor allows isolated profile-local pool prune"
isolated_files="$test_dir/isolated/store/v11/files"
mkdir -p "$isolated_files"
isolated_registry="$test_dir/isolated-registry.json"
cat > "$isolated_registry" <<EOF
{
  "profiles": [
    {"id": "isolated", "project": "isolated", "store": "$test_dir/isolated/store", "filesPoolId": "pool-isolated"}
  ],
  "pools": [
    {"id": "pool-isolated", "filesPath": "$isolated_files"}
  ]
}
EOF
doctor_isolated="$test_dir/doctor-isolated.json"
dependency_materialization_store_doctor node "$isolated_registry" isolated > "$doctor_isolated"
assert_json_field \
  "allow-profile-local-prune" \
  "$doctor_isolated" \
  "(value) => value.decision" \
  "isolated local pool prune is allowed"

echo "Test 38: repair plan targets every root sharing a files pool"
repair_plan="$test_dir/repair-plan.json"
dependency_materialization_repair_plan node "$doctor_registry" pool-shared > "$repair_plan"
assert_json_field \
  "repair-all-roots" \
  "$repair_plan" \
  "(value) => value.decision" \
  "shared pool repair plans coordinated rebuild"
assert_json_field \
  "profile-a,profile-b" \
  "$repair_plan" \
  "(value) => value.roots.map((root) => root.profile).join(',')" \
  "shared pool repair plan lists all roots"

echo ""
echo "All pnpm task helper tests passed"
