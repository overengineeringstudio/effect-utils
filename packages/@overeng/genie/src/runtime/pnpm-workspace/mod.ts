/**
 * Type-safe pnpm-workspace.yaml generator
 *
 * Full API coverage for pnpm-workspace.yaml settings.
 * Reference: https://pnpm.io/pnpm-workspace_yaml
 */

import type { GenieOutput, Strict } from '../mod.ts'
import { stringify } from '../utils/yaml.ts'

// =============================================================================
// Settings Types
// https://pnpm.io/settings
// =============================================================================

/**
 * pnpm settings that can be set in pnpm-workspace.yaml
 *
 * These settings configure pnpm's behavior for the entire workspace.
 * They can be placed under `settings:` or at the top level for backwards compatibility.
 *
 * @see https://pnpm.io/settings
 */
export interface PnpmSettings {
  // ---------------------------------------------------------------------------
  // Dependency Resolution
  // https://pnpm.io/settings#dependency-resolution-settings
  // ---------------------------------------------------------------------------

  /**
   * The directory in which dependencies will be installed (instead of `node_modules`).
   * @see https://pnpm.io/settings#modules-dir
   */
  modulesDir?: string

  /**
   * Symlinks leaf dependencies to `node_modules/.pnpm/node_modules`.
   * @see https://pnpm.io/settings#symlink-packages
   */
  symlinkPackages?: boolean

  /**
   * Allow packages that require nodejs 18 when current node is 22.
   * @see https://pnpm.io/settings#ignore-compatibility-db
   */
  ignoreCompatibilityDb?: boolean

  /**
   * If true, pnpm only links packages from the store to node_modules.
   * @see https://pnpm.io/settings#prefer-offline
   */
  preferOffline?: boolean

  /**
   * If true, pnpm only uses packages from the store.
   * @see https://pnpm.io/settings#offline
   */
  offline?: boolean

  /**
   * Resolution strategy. `highest` (default) or `lowest` or `lowest-direct` or `time-based`.
   * @see https://pnpm.io/settings#resolution-mode
   */
  resolutionMode?: 'highest' | 'lowest' | 'lowest-direct' | 'time-based'

  // ---------------------------------------------------------------------------
  // Hoisting Settings
  // https://pnpm.io/settings#hoisting-settings
  // ---------------------------------------------------------------------------

  /**
   * Enable package hoisting.
   * @see https://pnpm.io/settings#hoist
   */
  hoist?: boolean

  /**
   * Glob patterns of packages to hoist to `node_modules/.pnpm/node_modules`.
   * @see https://pnpm.io/settings#hoist-pattern
   */
  hoistPattern?: readonly string[]

  /**
   * Glob patterns of packages to hoist to the root `node_modules`.
   * @see https://pnpm.io/settings#public-hoist-pattern
   */
  publicHoistPattern?: readonly string[]

  /**
   * Hoist all dependencies matching hoistPattern to the root node_modules.
   * @see https://pnpm.io/settings#shamefully-hoist
   */
  shamefullyHoist?: boolean

  // ---------------------------------------------------------------------------
  // Node-Modules Settings
  // https://pnpm.io/settings#node-modules-settings
  // ---------------------------------------------------------------------------

  /**
   * The node_modules layout.
   * @see https://pnpm.io/settings#node-linker
   */
  nodeLinker?: 'hoisted' | 'isolated' | 'pnp'

  /**
   * Pnpm-lock.yaml will be deterministic and independent of system environment.
   * @see https://pnpm.io/settings#use-lockfile-v6
   * @deprecated Use lockfileVersion instead
   */
  useLockfileV6?: boolean

  /**
   * Link package bins to node_modules/.bin.
   * @see https://pnpm.io/settings#enable-global-packages-bin
   */
  enableGlobalPackagesBin?: boolean

  // ---------------------------------------------------------------------------
  // Store Settings
  // https://pnpm.io/settings#store-settings
  // ---------------------------------------------------------------------------

  /**
   * The location of the content-addressable store.
   * @see https://pnpm.io/settings#store-dir
   */
  storeDir?: string

  /**
   * If true, pnpm only copies files from the store.
   * @see https://pnpm.io/settings#package-import-method
   */
  packageImportMethod?: 'auto' | 'hardlink' | 'copy' | 'clone' | 'clone-or-copy'

  // ---------------------------------------------------------------------------
  // Lockfile Settings
  // https://pnpm.io/settings#lockfile-settings
  // ---------------------------------------------------------------------------

  /**
   * When set to false, pnpm won't read or generate a lockfile.
   * @see https://pnpm.io/settings#lockfile
   */
  lockfile?: boolean

  /**
   * If true, generate a lockfile even if frozen is set.
   * @see https://pnpm.io/settings#prefer-frozen-lockfile
   */
  preferFrozenLockfile?: boolean

  /**
   * Git-merge lockfile in lockfile during merge conflicts.
   * @see https://pnpm.io/settings#git-branch-lockfile
   */
  gitBranchLockfile?: boolean

  /**
   * Merge lockfiles from git.
   * @see https://pnpm.io/settings#merge-git-branch-lockfiles
   */
  mergeGitBranchLockfiles?: boolean

  /**
   * The lockfile will have the peers resolved at the top level.
   * @see https://pnpm.io/settings#peers-suffix-max-length
   */
  peersSuffixMaxLength?: number

  // ---------------------------------------------------------------------------
  // Registry & Authentication Settings
  // https://pnpm.io/settings#registry-settings
  // ---------------------------------------------------------------------------

  /**
   * The default npm registry.
   * @see https://pnpm.io/settings#registry
   */
  registry?: string

  // ---------------------------------------------------------------------------
  // Request Settings
  // https://pnpm.io/settings#request-settings
  // ---------------------------------------------------------------------------

  /**
   * Set user-agent request header.
   * @see https://pnpm.io/settings#user-agent
   */
  userAgent?: string

  /**
   * Controls npm request timeouts.
   * @see https://pnpm.io/settings#fetch-timeout
   */
  fetchTimeout?: number

  /**
   * How many times to retry failed requests.
   * @see https://pnpm.io/settings#fetch-retries
   */
  fetchRetries?: number

  // ---------------------------------------------------------------------------
  // Peer Dependency Settings
  // https://pnpm.io/settings#peer-dependency-settings
  // ---------------------------------------------------------------------------

  /**
   * When enabled, dependencies that have peer dependencies are deduplicated.
   * @see https://pnpm.io/settings#dedupe-peer-dependents
   */
  dedupePeerDependents?: boolean

  /**
   * If enabled, peer dependencies are automatically installed.
   * @see https://pnpm.io/settings#auto-install-peers
   */
  autoInstallPeers?: boolean

  /**
   * Resolve unmet peer dependencies from parent packages.
   * @see https://pnpm.io/settings#resolve-peers-from-workspace-root
   */
  resolvePeersFromWorkspaceRoot?: boolean

  /**
   * Use strict peer dependencies mode.
   * @see https://pnpm.io/settings#strict-peer-dependencies
   */
  strictPeerDependencies?: boolean

  // ---------------------------------------------------------------------------
  // CLI Settings
  // https://pnpm.io/settings#cli-settings
  // ---------------------------------------------------------------------------

  /**
   * When running scripts, prefer npm's behavior.
   * @see https://pnpm.io/settings#script-shell
   */
  scriptShell?: string

  /**
   * If true, pnpm will exit with error if script is not found.
   * @see https://pnpm.io/settings#strict-scripts
   * @deprecated Use `script-missing` instead
   */
  strictScripts?: boolean

  /**
   * Behavior when script is missing. 'error' | 'warn' | 'silent'
   * @see https://pnpm.io/settings#script-missing
   */
  scriptMissing?: 'error' | 'warn' | 'silent'

  /**
   * Behavior when workspace package depends on version not matched by local.
   * @see https://pnpm.io/settings#link-workspace-packages
   */
  linkWorkspacePackages?: boolean | 'deep'

  /**
   * If true, only workspace packages from the monorepo are used.
   * @see https://pnpm.io/settings#prefer-workspace-packages
   */
  preferWorkspacePackages?: boolean

  /**
   * The directory to search for packages to link.
   * @see https://pnpm.io/settings#virtual-store-dir
   */
  virtualStoreDir?: string

  /**
   * Additional directories containing packages that pnpm should link.
   * @see https://pnpm.io/settings#virtual-store-dir-max-length
   */
  virtualStoreDirMaxLength?: number

  /**
   * Check for side effects cache.
   * @see https://pnpm.io/settings#side-effects-cache
   */
  sideEffectsCache?: boolean

  /**
   * Side effects cache readonly mode.
   * @see https://pnpm.io/settings#side-effects-cache-readonly
   */
  sideEffectsCacheReadonly?: boolean

  /**
   * Check if node_modules was modified.
   * @see https://pnpm.io/settings#verify-store-integrity
   */
  verifyStoreIntegrity?: boolean

  /**
   * Ignore scripts in build.
   * @see https://pnpm.io/settings#ignore-scripts
   */
  ignoreScripts?: boolean

  /**
   * Child concurrency.
   * @see https://pnpm.io/settings#child-concurrency
   */
  childConcurrency?: number

  /**
   * Network concurrency.
   * @see https://pnpm.io/settings#network-concurrency
   */
  networkConcurrency?: number

  // ---------------------------------------------------------------------------
  // Build Settings
  // https://pnpm.io/settings#build-settings
  // ---------------------------------------------------------------------------

  /**
   * When true, only packages in onlyBuiltDependencies are built.
   * @see https://pnpm.io/settings#ignore-dep-scripts
   */
  ignoreDepScripts?: boolean

  // ---------------------------------------------------------------------------
  // Node.js Settings
  // https://pnpm.io/settings#nodejs-settings
  // ---------------------------------------------------------------------------

  /**
   * The Node.js version to use in build.
   * @see https://pnpm.io/settings#use-node-version
   */
  useNodeVersion?: string

  /**
   * Check that pnpm version matches packageManager field.
   * @see https://pnpm.io/settings#manage-package-manager-versions
   */
  managePackageManagerVersions?: boolean

  // ---------------------------------------------------------------------------
  // Workspace Settings
  // https://pnpm.io/settings#workspace-settings
  // ---------------------------------------------------------------------------

  /**
   * Save packages to workspace package.json instead of root.
   * @see https://pnpm.io/settings#shared-workspace-lockfile
   */
  sharedWorkspaceLockfile?: boolean

  /**
   * If true, concurrent builds within a workspace are not allowed.
   * @see https://pnpm.io/settings#enable-pre-post-scripts
   */
  enablePrePostScripts?: boolean

  /**
   * Don't run pre/post install scripts.
   * @see https://pnpm.io/settings#recursive-install
   */
  recursiveInstall?: boolean

  // ---------------------------------------------------------------------------
  // Other Settings
  // https://pnpm.io/settings#other-settings
  // ---------------------------------------------------------------------------

  /**
   * When enabled, saves exact version instead of range.
   * @see https://pnpm.io/settings#save-exact
   */
  saveExact?: boolean

  /**
   * Default prefix for dependencies.
   * @see https://pnpm.io/settings#save-prefix
   */
  savePrefix?: string

  /**
   * Save to dev dependencies by default.
   * @see https://pnpm.io/settings#save-workspace-protocol
   */
  saveWorkspaceProtocol?: boolean | 'rolling'

  /**
   * The package.json field to use for engines.
   * @see https://pnpm.io/settings#use-running-store-server
   * @deprecated
   */
  useRunningStoreServer?: boolean

  /**
   * Use pre-built binaries from npm.
   * @see https://pnpm.io/settings#use-store-server
   * @deprecated
   */
  useStoreServer?: boolean

  /**
   * Verify dependencies are from registry.
   * @see https://pnpm.io/settings#registry-supports-time-field
   */
  registrySupportsTimeField?: boolean

  /**
   * Extend node_modules by reading from a config file.
   * @see https://pnpm.io/settings#extend-node-path
   */
  extendNodePath?: boolean

  /**
   * Deploy package from the store.
   * @see https://pnpm.io/settings#deploy-all-files
   */
  deployAllFiles?: boolean

  /**
   * Dedupe packages by default.
   * @see https://pnpm.io/settings#dedupe-injected-deps
   */
  dedupeInjectedDeps?: boolean
}

// =============================================================================
// Peer Dependency Rules
// https://pnpm.io/pnpm-workspace_yaml#peerdependencyrules
// =============================================================================

/**
 * Rules for handling peer dependencies.
 * @see https://pnpm.io/pnpm-workspace_yaml#peerdependencyrules
 */
export interface PeerDependencyRules {
  /**
   * Packages in ignoreMissing will not produce warnings for missing peer dependencies.
   * @see https://pnpm.io/pnpm-workspace_yaml#peerdependencyrulesignoremissing
   */
  ignoreMissing?: readonly string[]

  /**
   * Package patterns that any peer dependency version is acceptable.
   * @see https://pnpm.io/pnpm-workspace_yaml#peerdependencyrulesallowany
   */
  allowAny?: readonly string[]

  /**
   * Specific version overrides for peer dependencies.
   * @see https://pnpm.io/pnpm-workspace_yaml#peerdependencyrulesallowedversions
   */
  allowedVersions?: Record<string, string>
}

// =============================================================================
// Main Configuration Type
// https://pnpm.io/pnpm-workspace_yaml
// =============================================================================

/**
 * Full configuration for pnpm-workspace.yaml
 *
 * @see https://pnpm.io/pnpm-workspace_yaml
 */
export interface PnpmWorkspaceData {
  /**
   * Workspace package patterns. Glob patterns to include packages.
   * @see https://pnpm.io/pnpm-workspace_yaml#packages
   * @example ['packages/*', 'apps/*']
   */
  packages?: readonly string[]

  /**
   * Default catalog of dependency versions.
   * @see https://pnpm.io/pnpm-workspace_yaml#catalog
   * @example { react: '18.2.0', typescript: '5.3.0' }
   */
  catalog?: Record<string, string>

  /**
   * Named catalogs for different dependency groups.
   * @see https://pnpm.io/pnpm-workspace_yaml#catalogs
   * @example { react17: { react: '17.0.2' }, react18: { react: '18.2.0' } }
   */
  catalogs?: Record<string, Record<string, string>>

  /**
   * Override dependency versions for all packages.
   * @see https://pnpm.io/pnpm-workspace_yaml#overrides
   * @example { 'lodash': '4.17.21' }
   */
  overrides?: Record<string, string>

  /**
   * Patched dependencies with patch file paths.
   * Paths can be repo-relative and will be resolved at stringify time.
   * @see https://pnpm.io/pnpm-workspace_yaml#patcheddependencies
   * @example { 'some-pkg@1.0.0': 'patches/some-pkg@1.0.0.patch' }
   */
  patchedDependencies?: Record<string, string>

  /**
   * Extend or fix package.json of dependencies.
   * @see https://pnpm.io/pnpm-workspace_yaml#packageextensions
   */
  packageExtensions?: Record<
    string,
    {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
  >

  /**
   * Rules for handling peer dependencies.
   * @see https://pnpm.io/pnpm-workspace_yaml#peerdependencyrules
   */
  peerDependencyRules?: PeerDependencyRules

  /**
   * Packages whose lifecycle scripts should never run.
   * @see https://pnpm.io/pnpm-workspace_yaml#neverbuiltdependencies
   * @example ['fsevents', 'esbuild']
   */
  neverBuiltDependencies?: readonly string[]

  /**
   * Only these packages will have their build scripts run.
   * @see https://pnpm.io/pnpm-workspace_yaml#onlybuiltdependencies
   * @example ['fsevents']
   */
  onlyBuiltDependencies?: readonly string[]

  /**
   * Packages whose build output warnings are ignored.
   * @see https://pnpm.io/pnpm-workspace_yaml#ignoredbuiltdependencies
   */
  ignoredBuiltDependencies?: readonly string[]

  /**
   * Allow deprecated versions for specific packages.
   * @see https://pnpm.io/pnpm-workspace_yaml#alloweddeprecatedversions
   */
  allowedDeprecatedVersions?: Record<string, string>

  /**
   * Configuration that should be shared by all packages.
   * @see https://pnpm.io/pnpm-workspace_yaml#settings
   */
  settings?: PnpmSettings

  // ---------------------------------------------------------------------------
  // Top-level settings (for backwards compatibility)
  // These are merged with settings when stringified
  // https://pnpm.io/settings
  // ---------------------------------------------------------------------------

  /**
   * When enabled, dependencies that have peer dependencies are deduplicated.
   * Prevents "Invalid hook call" errors when React is used across package boundaries.
   * @see https://pnpm.io/settings#dedupe-peer-dependents
   */
  dedupePeerDependents?: boolean

  /**
   * If enabled, peer dependencies are automatically installed.
   * @see https://pnpm.io/settings#auto-install-peers
   */
  autoInstallPeers?: boolean

  /**
   * Use strict peer dependencies mode.
   * @see https://pnpm.io/settings#strict-peer-dependencies
   */
  strictPeerDependencies?: boolean

  /**
   * Resolve unmet peer dependencies from parent packages.
   * @see https://pnpm.io/settings#resolve-peers-from-workspace-root
   */
  resolvePeersFromWorkspaceRoot?: boolean

  /**
   * Enable package hoisting.
   * @see https://pnpm.io/settings#hoist
   */
  hoist?: boolean

  /**
   * Hoist all dependencies matching hoistPattern to the root node_modules.
   * @see https://pnpm.io/settings#shamefully-hoist
   */
  shamefullyHoist?: boolean

  /**
   * Glob patterns of packages to hoist to `node_modules/.pnpm/node_modules`.
   * @see https://pnpm.io/settings#hoist-pattern
   */
  hoistPattern?: readonly string[]

  /**
   * Glob patterns of packages to hoist to the root `node_modules`.
   * @see https://pnpm.io/settings#public-hoist-pattern
   */
  publicHoistPattern?: readonly string[]

  /**
   * The node_modules layout.
   * @see https://pnpm.io/settings#node-linker
   */
  nodeLinker?: 'hoisted' | 'isolated' | 'pnp'

  /**
   * Behavior when workspace package depends on version not matched by local.
   * @see https://pnpm.io/settings#link-workspace-packages
   */
  linkWorkspacePackages?: boolean | 'deep'

  /**
   * If true, only workspace packages from the monorepo are used.
   * @see https://pnpm.io/settings#prefer-workspace-packages
   */
  preferWorkspacePackages?: boolean

  /**
   * When true, only packages in onlyBuiltDependencies are built.
   * @see https://pnpm.io/settings#ignore-dep-scripts
   */
  ignoreDepScripts?: boolean

  /**
   * Ignore scripts in build.
   * @see https://pnpm.io/settings#ignore-scripts
   */
  ignoreScripts?: boolean

  /**
   * If true, pnpm will exit with error if script is not found.
   * @see https://pnpm.io/settings#strict-scripts
   * @deprecated Use `script-missing` instead
   */
  strictScripts?: boolean

  /**
   * Save to dev dependencies by default.
   * @see https://pnpm.io/settings#save-workspace-protocol
   */
  saveWorkspaceProtocol?: boolean | 'rolling'
}

// =============================================================================
// Path Resolution Utilities
// =============================================================================

/**
 * Compute relative path from one repo-relative location to another.
 */
const computeRelativePath = ({ from, to }: { from: string; to: string }): string => {
  const normalizedFrom = from === '.' ? '' : from
  const fromParts = normalizedFrom.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }

  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  const relativePath = '../'.repeat(upCount) + downPath

  return relativePath || '.'
}

/**
 * Resolve patch paths, converting repo-relative paths to package-relative paths.
 *
 * Paths starting with `./` or `../` are kept as-is (already relative).
 * Other paths are treated as repo-relative and converted.
 */
const resolvePatchPaths = ({
  patches,
  currentLocation,
}: {
  patches: Record<string, string> | undefined
  currentLocation: string
}): Record<string, string> | undefined => {
  if (patches === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [pkg, path] of Object.entries(patches).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith('./') || path.startsWith('../')) {
      resolved[pkg] = path
    } else {
      const relativePath = computeRelativePath({
        from: currentLocation,
        to: path,
      })
      resolved[pkg] = relativePath
    }
  }
  return resolved
}

// =============================================================================
// Stringify Utilities
// =============================================================================

/**
 * Build the final YAML object with sorting and path resolution.
 */
const buildPnpmWorkspaceYaml = <T extends PnpmWorkspaceData>({
  data,
  location,
}: {
  data: T
  location: string
}): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  // Process all fields, resolving paths where needed
  if (data.packages !== undefined) {
    result.packages = [...data.packages]
  }

  if (data.catalog !== undefined) {
    result.catalog = { ...data.catalog }
  }

  if (data.catalogs !== undefined) {
    result.catalogs = { ...data.catalogs }
  }

  if (data.overrides !== undefined) {
    result.overrides = { ...data.overrides }
  }

  if (data.patchedDependencies !== undefined) {
    result.patchedDependencies = resolvePatchPaths({
      patches: data.patchedDependencies,
      currentLocation: location,
    })
  }

  if (data.packageExtensions !== undefined) {
    result.packageExtensions = { ...data.packageExtensions }
  }

  if (data.peerDependencyRules !== undefined) {
    result.peerDependencyRules = { ...data.peerDependencyRules }
  }

  if (data.neverBuiltDependencies !== undefined) {
    result.neverBuiltDependencies = [...data.neverBuiltDependencies]
  }

  if (data.onlyBuiltDependencies !== undefined) {
    result.onlyBuiltDependencies = [...data.onlyBuiltDependencies]
  }

  if (data.ignoredBuiltDependencies !== undefined) {
    result.ignoredBuiltDependencies = [...data.ignoredBuiltDependencies]
  }

  if (data.allowedDeprecatedVersions !== undefined) {
    result.allowedDeprecatedVersions = { ...data.allowedDeprecatedVersions }
  }

  if (data.settings !== undefined) {
    result.settings = { ...data.settings }
  }

  // Top-level settings (for backwards compatibility)
  if (data.dedupePeerDependents !== undefined) {
    result.dedupePeerDependents = data.dedupePeerDependents
  }

  if (data.autoInstallPeers !== undefined) {
    result.autoInstallPeers = data.autoInstallPeers
  }

  if (data.strictPeerDependencies !== undefined) {
    result.strictPeerDependencies = data.strictPeerDependencies
  }

  if (data.resolvePeersFromWorkspaceRoot !== undefined) {
    result.resolvePeersFromWorkspaceRoot = data.resolvePeersFromWorkspaceRoot
  }

  if (data.hoist !== undefined) {
    result.hoist = data.hoist
  }

  if (data.shamefullyHoist !== undefined) {
    result.shamefullyHoist = data.shamefullyHoist
  }

  if (data.hoistPattern !== undefined) {
    result.hoistPattern = [...data.hoistPattern]
  }

  if (data.publicHoistPattern !== undefined) {
    result.publicHoistPattern = [...data.publicHoistPattern]
  }

  if (data.nodeLinker !== undefined) {
    result.nodeLinker = data.nodeLinker
  }

  if (data.linkWorkspacePackages !== undefined) {
    result.linkWorkspacePackages = data.linkWorkspacePackages
  }

  if (data.preferWorkspacePackages !== undefined) {
    result.preferWorkspacePackages = data.preferWorkspacePackages
  }

  if (data.ignoreDepScripts !== undefined) {
    result.ignoreDepScripts = data.ignoreDepScripts
  }

  if (data.ignoreScripts !== undefined) {
    result.ignoreScripts = data.ignoreScripts
  }

  if (data.strictScripts !== undefined) {
    result.strictScripts = data.strictScripts
  }

  if (data.saveWorkspaceProtocol !== undefined) {
    result.saveWorkspaceProtocol = data.saveWorkspaceProtocol
  }

  return result
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Creates a pnpm-workspace.yaml configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * Patch paths are resolved relative to the package location at stringify time,
 * similar to how `packageJson` handles internal dependencies.
 *
 * @see https://pnpm.io/pnpm-workspace_yaml
 *
 * @example Basic usage
 * ```ts
 * import { pnpmWorkspaceYaml } from '@overeng/genie'
 *
 * export default pnpmWorkspaceYaml({
 *   packages: ['.', '../*'],
 *   dedupePeerDependents: true,
 * })
 * ```
 *
 * @example With catalog
 * ```ts
 * import { pnpmWorkspaceYaml } from '@overeng/genie'
 *
 * export default pnpmWorkspaceYaml({
 *   packages: ['packages/*'],
 *   catalog: {
 *     react: '18.2.0',
 *     typescript: '5.3.0',
 *   },
 * })
 * ```
 *
 * @example With patched dependencies
 * ```ts
 * import { pnpmWorkspaceYaml } from '@overeng/genie'
 *
 * export default pnpmWorkspaceYaml({
 *   packages: ['.'],
 *   patchedDependencies: {
 *     'some-pkg@1.0.0': 'patches/some-pkg@1.0.0.patch',
 *   },
 * })
 * ```
 */
export const pnpmWorkspaceYaml = <const T extends PnpmWorkspaceData>(
  config: Strict<T, PnpmWorkspaceData>,
): GenieOutput<T> => ({
  data: config,
  stringify: (ctx) => stringify(buildPnpmWorkspaceYaml({ data: config, location: ctx.location })),
})

// =============================================================================
// Legacy Export (deprecated)
// =============================================================================

/**
 * @deprecated Use `pnpmWorkspaceYaml` instead
 */
export const pnpmWorkspace = pnpmWorkspaceYaml
