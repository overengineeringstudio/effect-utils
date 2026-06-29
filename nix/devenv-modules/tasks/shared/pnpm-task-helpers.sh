#!/usr/bin/env bash

compute_hash() {
  sha256sum | awk '{print $1}'
}

ensure_local_pnpm_home_default() {
  local workspace_root="$1"

  if [ -z "${PNPM_HOME:-}" ]; then
    export PNPM_HOME="${workspace_root}/.pnpm-home"
  fi
}

emit_dir_state() {
  local dir="$1"

  if [ ! -d "$dir" ]; then
    return
  fi

  find "$dir" \
    \( \
      -name .git -o \
      -name .devenv -o \
      -name .turbo -o \
      -name .cache -o \
      -name node_modules -o \
      -name dist -o \
      -name coverage -o \
      -name result -o \
      -name tmp \
    \) -prune -o -type f -print \
    | LC_ALL=C sort \
    | while IFS= read -r file; do
      printf '%s ' "${file#"$dir"/}"
      sha256sum "$file" | awk '{print $1}'
    done
}

resolve_gvs_links_dir() {
  # pnpm 11 stores the GVS links under the effective store-dir. Prefer the
  # explicit store setting when tasks share storage across isolated PNPM_HOME
  # directories.
  if [ -n "${npm_config_store_dir:-}" ]; then
    printf '%s\n' "${npm_config_store_dir}/v11/links"
  elif [ -n "${PNPM_STORE_DIR:-}" ]; then
    printf '%s\n' "${PNPM_STORE_DIR}/v11/links"
  elif [ -n "${PNPM_HOME:-}" ]; then
    printf '%s\n' "${PNPM_HOME}/store/v11/links"
  elif [ -n "${XDG_DATA_HOME:-}" ] && [ -d "${XDG_DATA_HOME}/pnpm/store/v11" ]; then
    printf '%s\n' "${XDG_DATA_HOME}/pnpm/store/v11/links"
  elif [ -d "$HOME/.local/share/pnpm/store/v11" ]; then
    printf '%s\n' "$HOME/.local/share/pnpm/store/v11/links"
  elif [ -d "$HOME/Library/pnpm/store/v11" ]; then
    printf '%s\n' "$HOME/Library/pnpm/store/v11/links"
  fi
}

cache_fingerprint() {
  local workspace_state_hash="$1"
  local gvs_links_dir="$2"

  # pnpm 11 bakes absolute paths into the live GVS projection, so two installs
  # with identical manifests but different projection roots are not equivalent.
  {
    printf '%s\n' "$workspace_state_hash"
    printf '%s\n' "$gvs_links_dir"
  } | compute_hash
}

resolve_pnpm_install_contract_file() {
  local dir="${1:-$PWD}"

  while [ "$dir" != "/" ]; do
    if [ -f "$dir/pnpm-install-contract.json" ]; then
      printf '%s\n' "$dir/pnpm-install-contract.json"
      return 0
    fi

    dir="$(dirname "$dir")"
  done

  return 1
}

pnpm_contract_section_json() {
  local node_bin="$1"
  local contract_file="$2"
  local section="$3"

  "$node_bin" - "$contract_file" "$section" <<'EOF'
const fs = require('node:fs')

const [contractFile, section] = process.argv.slice(2)
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJson(nested)]),
  )
}

if (!Object.prototype.hasOwnProperty.call(contract, section)) {
  console.error(`[pnpm] pnpm install contract ${contractFile} has no section '${section}'`)
  process.exit(1)
}

process.stdout.write(`${JSON.stringify(stableJson(contract[section]))}\n`)
EOF
}

compute_pnpm_contract_section_hash() {
  local node_bin="$1"
  local contract_file="$2"
  local section="$3"

  pnpm_contract_section_json "$node_bin" "$contract_file" "$section" | compute_hash
}

pnpm_contract_supports_dependency_materialization_profile() {
  local node_bin="$1"
  local contract_file="$2"

  "$node_bin" - "$contract_file" <<'EOF'
const fs = require('node:fs')

const [contractFile] = process.argv.slice(2)
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))

process.exit(
  contract.dependencyMaterializationProfile?.schema === 'dependency-materialization-profile/v0'
    ? 0
    : 1,
)
EOF
}

dependency_materialization_validate_same_device() {
  local node_bin="$1"
  local workspace_dir="$2"
  local files_path="$3"

  "$node_bin" - "$workspace_dir" "$files_path" <<'EOF'
const fs = require('node:fs')

const [workspaceDir, filesPath] = process.argv.slice(2)
const realWorkspace = fs.realpathSync(workspaceDir)
const realFiles = fs.realpathSync(filesPath)
const workspaceDev = fs.statSync(realWorkspace).dev
const filesDev = fs.statSync(realFiles).dev

if (workspaceDev !== filesDev) {
  console.error('[pnpm] linuxSharedHardlink requires workspace and files pool on the same device')
  console.error(`[pnpm] workspace: ${realWorkspace} (dev ${workspaceDev})`)
  console.error(`[pnpm] files pool: ${realFiles} (dev ${filesDev})`)
  console.error('[pnpm] Use materializationProfile = "isolated" for cross-device reproduction.')
  process.exit(1)
}
EOF
}

prepare_dependency_materialization_store() {
  local node_bin="$1"
  local requested_profile="$2"
  local host_is_darwin="$3"
  local workspace_dir="$4"
  local store_dir="$5"

  case "$requested_profile" in
    auto | ciJobLocal | darwinSplitCas | linuxSharedHardlink | isolated) ;;
    *)
      echo "[pnpm] Unsupported materializationProfile: $requested_profile" >&2
      exit 1
      ;;
  esac

  if [ -z "${store_dir:-}" ]; then
    echo "[pnpm] npm_config_store_dir is empty; cannot prepare dependency materialization store" >&2
    exit 1
  fi

  local store_version_dir="$store_dir/v11"
  local files_path="$store_version_dir/files"
  local shared_files_path="${PNPM_SHARED_FILES_DIR:-$HOME/.local/share/pnpm/shared-files}/v11"
  local effective_profile="$requested_profile"

  if [ -n "${CI:-}" ]; then
    effective_profile="ciJobLocal"
  elif [ "$requested_profile" = auto ]; then
    if [ "$host_is_darwin" = true ]; then
      effective_profile="darwinSplitCas"
    else
      # Keep the first explicit-profile milestone behavior-compatible on Linux:
      # shared files pool with clone-or-copy imports. linuxSharedHardlink is
      # selectable, but auto needs separate workload proof before switching.
      effective_profile="darwinSplitCas"
    fi
  fi

  mkdir -p "$store_version_dir"

  case "$effective_profile" in
    ciJobLocal | isolated)
      if [ -L "$files_path" ]; then
        rm "$files_path"
      fi
      mkdir -p "$files_path"
      ;;
    darwinSplitCas | linuxSharedHardlink)
      mkdir -p "$shared_files_path"
      if [ -L "$files_path" ]; then
        if [ "$(readlink "$files_path")" != "$shared_files_path" ]; then
          echo "[pnpm] $files_path points at $(readlink "$files_path"), expected $shared_files_path" >&2
          exit 1
        fi
      elif [ -e "$files_path" ]; then
        if [ "$requested_profile" = auto ] && [ -d "$files_path" ] && [ -n "$(find "$files_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
          printf '%s\n' isolated
          return 0
        fi
        if [ -d "$files_path" ] && [ -z "$(find "$files_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
          rmdir "$files_path"
        else
          echo "[pnpm] $files_path is a non-empty local files store; choose materializationProfile = \"isolated\" or run the coordinated migration" >&2
          exit 1
        fi
      fi
      if [ ! -L "$files_path" ]; then
        ln -s "$shared_files_path" "$files_path"
      fi
      if [ "$effective_profile" = linuxSharedHardlink ]; then
        dependency_materialization_validate_same_device "$node_bin" "$workspace_dir" "$files_path"
      fi
      ;;
  esac

  printf '%s\n' "$effective_profile"
}

dependency_materialization_install_policy_flags() {
  local profile="$1"

  case "$profile" in
    linuxSharedHardlink)
      printf '%s\n' "--config.package-import-method=hardlink"
      ;;
    ciJobLocal | darwinSplitCas | isolated)
      printf '%s\n' "--config.package-import-method=clone-or-copy"
      ;;
    *)
      echo "[pnpm] Unsupported dependency materialization profile for install policy: $profile" >&2
      exit 1
      ;;
  esac
}

emit_dependency_materialization_profile() {
  local node_bin="$1"
  local contract_file="$2"
  local store_trait="$3"
  local output_file="${4:-}"
  local workspace_dir="${5:-}"
  local store_dir="${6:-}"
  local package_import_method="${7:-}"

  "$node_bin" - "$contract_file" "$store_trait" "$output_file" "$workspace_dir" "$store_dir" "$package_import_method" <<'EOF'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const [contractFile, storeTrait, outputFile, workspaceDir, storeDir, packageImportMethodArg] = process.argv.slice(2)
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))
const evidenceContractPath = path.isAbsolute(contractFile)
  ? path.relative(fs.realpathSync(process.cwd()), fs.realpathSync(contractFile))
  : contractFile

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJson(nested)]),
  )
}

const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(`${JSON.stringify(stableJson(value))}\n`)
    .digest('hex')

const profileContract = contract.dependencyMaterializationProfile
if (profileContract?.schema !== 'dependency-materialization-profile/v0') {
  console.error(`[pnpm] ${contractFile} has no dependencyMaterializationProfile schema`)
  process.exit(1)
}

const trait = profileContract.supportedTraits?.[storeTrait]
if (trait === undefined) {
  console.error(`[pnpm] unsupported dependency materialization store trait '${storeTrait}'`)
  process.exit(1)
}

const storeLayoutVersion = contract.storeContract?.layoutVersion ?? 'v11'
const filesPath = storeDir ? path.join(storeDir, storeLayoutVersion, 'files') : undefined
const realPathOf = (candidate) => {
  if (!candidate) return undefined
  try {
    return fs.realpathSync(candidate)
  } catch {
    return candidate
  }
}
const filesRealPath = realPathOf(filesPath)
const workspaceRealPath = realPathOf(workspaceDir)
const sameDevice = (() => {
  if (!workspaceRealPath || !filesRealPath) return undefined
  try {
    return fs.statSync(workspaceRealPath).dev === fs.statSync(filesRealPath).dev
  } catch {
    return undefined
  }
})()
const packageImportMethod = packageImportMethodArg || trait.importMethod

const inputSections = Object.fromEntries(
  profileContract.identityInputs.map((section) => {
    if (!Object.prototype.hasOwnProperty.call(contract, section)) {
      console.error(`[pnpm] ${contractFile} has no identity section '${section}'`)
      process.exit(1)
    }
    return [section, contract[section]]
  }),
)

const sectionDigests = Object.fromEntries(
  Object.entries(inputSections).map(([section, value]) => [section, digest(value)]),
)
const topologyDigest = digest({
  packageManager: inputSections.packageManager,
  workspaceManifestContract: inputSections.workspaceManifestContract,
})
const policyDigest = digest({
  gvsLinkContract: inputSections.gvsLinkContract,
  installPolicy: inputSections.installPolicy,
})
const storeDigest = digest({
  storeContract: inputSections.storeContract,
  storeTrait,
  trait,
})

const profile = {
  schema: 'dependency-materialization-profile/v0',
  profileId: `pnpm:${topologyDigest}:${policyDigest}:${storeDigest}:${storeTrait}`,
  store: {
    trait: storeTrait,
    contract: inputSections.storeContract,
    filesPath,
    filesRealPath,
    sameDeviceRequired: trait.sameDeviceRequired === true,
    sameDevice,
    packageImportMethod,
  },
  authorities: {
    gc: trait.gcAuthority,
    repair: trait.repairAuthority,
  },
  topology: {
    digest: topologyDigest,
    workspaceManifestContractDigest: sectionDigests.workspaceManifestContract,
  },
  policy: {
    digest: policyDigest,
    gvsLinkContractDigest: sectionDigests.gvsLinkContract,
    installPolicyDigest: sectionDigests.installPolicy,
    nativeBuildPolicyInputs: profileContract.nativeBuildPolicyInputs,
  },
  evidence: {
    contractPath: evidenceContractPath,
    sectionDigests,
  },
}

const rendered = `${JSON.stringify(profile, null, 2)}\n`
if (outputFile) {
  fs.writeFileSync(outputFile, rendered)
} else {
  process.stdout.write(rendered)
}
EOF
}

write_dependency_materialization_registry() {
  local node_bin="$1"
  local profile_file="$2"
  local project_dir="$3"
  local store_dir="$4"
  local output_file="$5"
  local shared_registry_file="${6:-}"

  "$node_bin" - "$profile_file" "$project_dir" "$store_dir" "$output_file" "$shared_registry_file" <<'EOF'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const [profileFile, projectDir, storeDir, outputFile, sharedRegistryFile] = process.argv.slice(2)
const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
const storeLayoutVersion = 'v11'
const filesPath = path.join(storeDir, storeLayoutVersion, 'files')

const realFilesPath = (() => {
  try {
    return fs.realpathSync(filesPath)
  } catch {
    return filesPath
  }
})()

const poolId = crypto
  .createHash('sha256')
  .update(`${realFilesPath}\n`)
  .digest('hex')
const rootId = crypto
  .createHash('sha256')
  .update(`${profile.profileId}\n${projectDir}\n${storeDir}\n`)
  .digest('hex')

const singletonRegistry = {
  schema: 'dependency-materialization-registry/v0',
  profiles: [
    {
      id: rootId,
      profileId: profile.profileId,
      trait: profile.store?.trait,
      project: projectDir,
      store: storeDir,
      filesPoolId: poolId,
    },
  ],
  pools: [
    {
      id: poolId,
      filesPath,
      filesRealPath: realFilesPath,
      sameDeviceRequired: profile.store?.sameDeviceRequired === true,
      sameDevice: profile.store?.sameDevice,
    },
  ],
}

const readRegistry = (file) => {
  if (!file || !fs.existsSync(file)) {
    return { schema: 'dependency-materialization-registry/v0', profiles: [], pools: [] }
  }

  const registry = JSON.parse(fs.readFileSync(file, 'utf8'))
  return {
    schema: 'dependency-materialization-registry/v0',
    profiles: Array.isArray(registry.profiles) ? registry.profiles : [],
    pools: Array.isArray(registry.pools) ? registry.pools : [],
  }
}

const upsertBy = (rows, row, key) => [
  ...rows.filter((candidate) => candidate[key] !== row[key]),
  row,
].sort((left, right) => left[key].localeCompare(right[key]))

const merged = readRegistry(sharedRegistryFile)
const nextProfile = singletonRegistry.profiles[0]
const withoutSameRoot = merged.profiles.filter(
  (candidate) => candidate.project !== nextProfile.project || candidate.store !== nextProfile.store,
)
merged.profiles = upsertBy(withoutSameRoot, nextProfile, 'id')
merged.pools = upsertBy(merged.pools, singletonRegistry.pools[0], 'id')

const rendered = `${JSON.stringify(merged, null, 2)}\n`
if (sharedRegistryFile) {
  fs.mkdirSync(path.dirname(sharedRegistryFile), { recursive: true })
  const tmpFile = `${sharedRegistryFile}.${process.pid}.tmp`
  fs.writeFileSync(tmpFile, rendered)
  fs.renameSync(tmpFile, sharedRegistryFile)
}
fs.writeFileSync(outputFile, rendered)
EOF
}

dependency_materialization_shared_registry_file() {
  local node_bin="$1"
  local store_dir="$2"

  "$node_bin" - "$store_dir" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const [storeDir] = process.argv.slice(2)
const storeLayoutVersion = 'v11'
const filesPath = path.join(storeDir, storeLayoutVersion, 'files')
const realFilesPath = (() => {
  try {
    return fs.realpathSync(filesPath)
  } catch {
    return filesPath
  }
})()

process.stdout.write(path.join(
  path.dirname(realFilesPath),
  `.effect-utils-dependency-materialization-registry-${storeLayoutVersion}.json`,
))
EOF
}

dependency_materialization_profile_id() {
  local node_bin="$1"
  local profile_file="$2"

  "$node_bin" - "$profile_file" <<'EOF'
const fs = require('node:fs')

const [profileFile] = process.argv.slice(2)
const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
process.stdout.write(profile.profileId)
EOF
}

dependency_materialization_profile_files_pool_id() {
  local node_bin="$1"
  local registry_file="$2"
  local profile_id="$3"

  "$node_bin" - "$registry_file" "$profile_id" <<'EOF'
const fs = require('node:fs')

const [registryFile, profileId] = process.argv.slice(2)
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const profiles = Array.isArray(registry.profiles) ? registry.profiles : []
const profile = profiles.find((row) => row.id === profileId || row.profileId === profileId)

if (profile === undefined || typeof profile.filesPoolId !== 'string') {
  process.exit(1)
}

process.stdout.write(profile.filesPoolId)
EOF
}

dependency_materialization_profile_store_dir() {
  local node_bin="$1"
  local registry_file="$2"
  local profile_id="$3"

  "$node_bin" - "$registry_file" "$profile_id" <<'EOF'
const fs = require('node:fs')

const [registryFile, profileId] = process.argv.slice(2)
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const profiles = Array.isArray(registry.profiles) ? registry.profiles : []
const profile = profiles.find((row) => row.id === profileId || row.profileId === profileId)

if (profile === undefined || typeof profile.store !== 'string') {
  process.exit(1)
}

process.stdout.write(profile.store)
EOF
}

dependency_materialization_repair_roots() {
  local node_bin="$1"
  local registry_file="$2"
  local files_pool_id="$3"

  "$node_bin" - "$registry_file" "$files_pool_id" <<'EOF'
const fs = require('node:fs')

const [registryFile, filesPoolId] = process.argv.slice(2)
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const profiles = Array.isArray(registry.profiles) ? registry.profiles : []

for (const profile of profiles
  .filter((row) => row.filesPoolId === filesPoolId)
  .sort((left, right) => left.id.localeCompare(right.id))) {
  process.stdout.write(`${profile.project}\t${profile.store}\n`)
}
EOF
}

dependency_materialization_store_doctor() {
  local node_bin="$1"
  local registry_file="$2"
  local profile_id="$3"

  "$node_bin" - "$registry_file" "$profile_id" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const [registryFile, profileId] = process.argv.slice(2)
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))

const classifyPool = (pool) => {
  if (pool.filesKind !== undefined) return pool.filesKind
  if (typeof pool.filesPath !== 'string') return 'missing'

  try {
    const stat = fs.lstatSync(pool.filesPath)
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(pool.filesPath)
      const localRoot = path.dirname(path.dirname(pool.filesPath))
      return target.startsWith(`${localRoot}${path.sep}`)
        ? 'profile-local-symlink'
        : 'shared-symlink'
    }
    if (stat.isDirectory()) return 'directory'
    return 'invalid'
  } catch {
    return 'missing'
  }
}

const profiles = Array.isArray(registry.profiles) ? registry.profiles : []
const pools = Array.isArray(registry.pools) ? registry.pools : []
const profile = profiles.find((row) => row.id === profileId || row.profileId === profileId)

if (profile === undefined) {
  console.log(JSON.stringify({ phase: 'doctor', profileId, decision: 'refuse', reason: 'unknown-profile', siblings: [] }))
  process.exit(0)
}

const pool = pools.find((row) => row.id === profile.filesPoolId)
if (pool === undefined) {
  console.log(JSON.stringify({ phase: 'doctor', profileId, filesPoolId: profile.filesPoolId, decision: 'refuse', reason: 'unknown-files-pool', siblings: [] }))
  process.exit(0)
}

const filesKind = classifyPool(pool)
const siblings = profiles
  .filter((row) => row.filesPoolId === pool.id)
  .map((row) => row.id)
  .sort()

if ((filesKind === 'directory' || filesKind === 'profile-local-symlink') && siblings.length === 1) {
  console.log(JSON.stringify({ phase: 'doctor', profileId, filesPoolId: pool.id, decision: 'allow-profile-local-prune', reason: 'profile-local-files-pool', siblings, filesKind }))
  process.exit(0)
}

console.log(JSON.stringify({
  phase: 'doctor',
  profileId,
  filesPoolId: pool.id,
  decision: 'refuse-raw-prune',
  reason: filesKind === 'shared-symlink' ? 'shared-files-pool' : 'invalid-files-pool',
  siblings,
  filesKind,
}))
EOF
}

dependency_materialization_repair_plan() {
  local node_bin="$1"
  local registry_file="$2"
  local files_pool_id="$3"

  "$node_bin" - "$registry_file" "$files_pool_id" <<'EOF'
const fs = require('node:fs')

const [registryFile, filesPoolId] = process.argv.slice(2)
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const profiles = Array.isArray(registry.profiles) ? registry.profiles : []
const roots = profiles
  .filter((profile) => profile.filesPoolId === filesPoolId)
  .map((profile) => ({ profile: profile.id, project: profile.project, store: profile.store }))
  .sort((left, right) => left.profile.localeCompare(right.profile))

if (roots.length === 0) {
  console.log(JSON.stringify({ phase: 'repair-plan', filesPoolId, decision: 'refuse', reason: 'no-registered-roots', roots }))
} else {
  console.log(JSON.stringify({ phase: 'repair-plan', filesPoolId, decision: 'repair-all-roots', reason: 'registered-roots', roots }))
}
EOF
}

classify_pnpm_contract_change() {
  local node_bin="$1"
  local previous_contract="$2"
  local current_contract="$3"

  "$node_bin" - "$previous_contract" "$current_contract" <<'EOF'
const fs = require('node:fs')
const crypto = require('node:crypto')

const [previousContractFile, currentContractFile] = process.argv.slice(2)

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJson(nested)]),
  )
}

const sectionHash = (contract, section, contractFile) => {
  if (!Object.prototype.hasOwnProperty.call(contract, section)) {
    console.error(`[pnpm] pnpm install contract ${contractFile} has no section '${section}'`)
    process.exit(1)
  }

  return crypto
    .createHash('sha256')
    .update(`${JSON.stringify(stableJson(contract[section]))}\n`)
    .digest('hex')
}

const previousContract = JSON.parse(fs.readFileSync(previousContractFile, 'utf8'))
const currentContract = JSON.parse(fs.readFileSync(currentContractFile, 'utf8'))

for (const [section, reason] of [
  ['packageManager', 'toolchain'],
  ['gvsLinkContract', 'gvs-link'],
  ['installPolicy', 'policy'],
  ['storeContract', 'store'],
  ['workspaceManifestContract', 'manifest_config'],
]) {
  if (
    sectionHash(previousContract, section, previousContractFile) !==
    sectionHash(currentContract, section, currentContractFile)
  ) {
    process.stdout.write(`${reason}\n`)
    process.exit(0)
  }
}

process.stdout.write('unknown\n')
EOF
}

emit_pnpm_install_miss_span() {
  local task_name="$1"
  local reason="$2"

  if command -v otel-span >/dev/null 2>&1 && { [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] || { [ -n "${OTEL_SPAN_SPOOL_DIR:-}" ] && [ -d "${OTEL_SPAN_SPOOL_DIR:-}" ]; }; }; then
    otel-span emit-span "effect-utils-devenv" "devenv.task.status" \
      --attr "tool.name=devenv" \
      --attr "task.name=${task_name}" \
      --attr "task.phase=status" \
      --attr "task.cached=false" \
      --attr "status.method=hash" \
      --attr-string "span.label=${reason}" \
      --attr-string "install.miss_reason=${reason}" >/dev/null 2>&1 || true
  fi
}

check_node_modules_links_healthy() {
  local node_bin="$1"
  local projection_script="$2"
  shift 2

  for node_modules_dir in "$@"; do
    if [ ! -d "$node_modules_dir" ]; then
      continue
    fi

    broken_link="$(
      find "$node_modules_dir" -mindepth 1 -maxdepth 2 -type l ! -exec test -e {} \; -print -quit
    )"
    if [ -n "$broken_link" ]; then
      echo "[pnpm] Broken node_modules symlink detected: $broken_link" >&2
      return 1
    fi
  done

  # Feed the projection checker the exact node_modules directories we validated
  # for broken symlinks so the fast path and the authoritative task share the
  # same notion of a healthy pnpm projection.
  NODE_MODULES_DIRS="$(printf '%s\n' "$@")" "$node_bin" "$projection_script"
}

purge_node_modules() {
  for node_modules_dir in "$@"; do
    rm -rf "$node_modules_dir"
  done
}

resolve_package_bin() {
  local package_name="$1"
  local bin_name="${2:-$1}"
  local cwd="${3:-$PWD}"
  local node_bin="${NODE_BIN:-node}"
  local shim_path="$cwd/node_modules/.bin/$bin_name"

  if [ -x "$shim_path" ]; then
    printf '%s\n' "$shim_path"
    return 0
  fi

  "$node_bin" - "$package_name" "$bin_name" "$cwd" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const [packageName, binName, cwd] = process.argv.slice(2)

const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [cwd] })
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const packageDir = path.dirname(manifestPath)

const candidates = []
if (typeof manifest.bin === 'string') {
  candidates.push(manifest.bin)
} else if (manifest.bin && typeof manifest.bin === 'object') {
  if (typeof manifest.bin[binName] === 'string') {
    candidates.push(manifest.bin[binName])
  }
  if (typeof manifest.bin[packageName] === 'string' && manifest.bin[packageName] !== manifest.bin[binName]) {
    candidates.push(manifest.bin[packageName])
  }
  for (const value of Object.values(manifest.bin)) {
    if (typeof value === 'string' && !candidates.includes(value)) {
      candidates.push(value)
    }
  }
}

if (candidates.length === 0) {
  console.error(`[pnpm] Package '${packageName}' does not declare a usable bin entry for '${binName}'`)
  process.exit(1)
}

for (const candidate of candidates) {
  const resolved = path.resolve(packageDir, candidate)
  if (fs.existsSync(resolved)) {
    process.stdout.write(`${resolved}\n`)
    process.exit(0)
  }
}

console.error(`[pnpm] Could not resolve an existing bin path for '${packageName}' from ${manifestPath}`)
process.exit(1)
EOF
}

run_package_bin() {
  local package_name="$1"
  local bin_name="${2:-$1}"
  shift 2

  local bin_path
  bin_path="$(resolve_package_bin "$package_name" "$bin_name")"
  "$bin_path" "$@"
}
