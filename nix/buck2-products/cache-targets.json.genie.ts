import { readFileSync } from 'node:fs'

import {
  assertPublishedPackageClosure,
  type PublishedPackageManifest,
} from '../../genie/buck2/package-product-inventory.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const javascriptProducts = [
  [
    'ai-gateway-edge',
    'ai-gateway-edge.js',
    'packages/@overeng/ai-gateway-edge',
    'ai-gateway-edge-candidate',
  ],
  ['ci-tools', 'ci-tools.js', 'packages/@overeng/ci-tools', 'ci-tools-candidate'],
  ['genie', 'genie.js', 'packages/@overeng/genie', 'genie-candidate'],
  [
    'genie-bootstrap-closure-check',
    'genie-bootstrap-closure-check.js',
    'packages/@overeng/genie',
    'genie-bootstrap-closure-check-candidate',
  ],
  ['gh-ci-utils', 'gh-ci-utils.js', 'packages/@overeng/gh-ci-utils', 'gh-ci-utils-candidate'],
  ['megarepo', 'mr.js', 'packages/@overeng/megarepo', 'megarepo-candidate'],
  ['notion-cli', 'notion.js', 'packages/@overeng/notion-cli', 'notion-cli-candidate'],
  [
    'notion-db-runtime',
    'notion-db.js',
    'packages/@overeng/notion-cli',
    'notion-db-candidate',
    'packages/@overeng/notion-datasource-sync',
  ],
  ['notion-md', 'notion-md.js', 'packages/@overeng/notion-md', 'notion-md-candidate'],
  ['npm-release', 'npm-release.js', 'packages/@overeng/npm-release', 'npm-release-candidate'],
  ['oxc-config', 'oxc-config.js', 'packages/@overeng/oxc-config', 'oxc-config-candidate'],
  [
    'oxc-config-stylex-upstream-plugin',
    'oxc-config-stylex-upstream-plugin.js',
    'packages/@overeng/oxc-config',
    'oxc-config-stylex-upstream-plugin-candidate',
  ],
  ['tui-stories', 'tui-stories.js', 'packages/@overeng/tui-stories', 'tui-stories-candidate'],
] as const

const packageProducts = [
  '@overeng/agent-session-ingest',
  '@overeng/ai-gateway-conformance',
  '@overeng/ai-gateway-edge',
  '@overeng/content-address',
  '@overeng/devbar',
  '@overeng/effect-ai-claude-cli',
  '@overeng/effect-ai-gateway',
  '@overeng/effect-distributed-lock',
  '@overeng/effect-react',
  '@overeng/effect-rpc-explorer',
  '@overeng/effect-rpc-explorer-react',
  '@overeng/effect-rust',
  '@overeng/genie',
  '@overeng/notion-core',
  '@overeng/notion-effect-client',
  '@overeng/notion-effect-schema',
  '@overeng/notion-md',
  '@overeng/notion-property-write',
  '@overeng/notion-react',
  '@overeng/outline',
  '@overeng/otel-contract',
  '@overeng/restate-effect',
  '@overeng/stylex-tokens',
  '@overeng/tui-core',
  '@overeng/tui-react',
  '@overeng/utils',
  '@overeng/utils-dev',
  '@overeng/utils-storybook',
] as const

const packageManifests = packageProducts.map(
  (name) =>
    JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8')) as PublishedPackageManifest & {
      readonly version: string
    },
)
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly workspaces: readonly string[]
}
const workspaceNames = new Set(
  rootPackage.workspaces.map(
    (path) => {
      const packageJson: unknown = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'))
      if (
        packageJson === null ||
        typeof packageJson !== 'object' ||
        'name' in packageJson === false ||
        typeof packageJson.name !== 'string'
      ) {
        throw new Error(`Invalid workspace package name in ${path}/package.json`)
      }
      return packageJson.name
    },
  ),
)
assertPublishedPackageClosure({ packages: packageManifests, workspaceNames })

const packageEntries = packageManifests.map((packageJson) => {
  const name = packageJson.name
  const packagePath = `packages/${name}`
  return {
    kind: 'package',
    name,
    outputName: `${name.replace('@', '').replace('/', '-')}.tgz`,
    packagePath,
    packageTreePath: packagePath,
    target: `effect_utils//${packagePath}:dist-package`,
    version: packageJson.version,
  } as const
})

/**
 * Single inventory of every cache product. `cache.nix` reads it as the target
 * set and `source-recipes.nix` derives the from-source recipe for each entry, so
 * the two cannot drift. Runtime workspace dependencies must also be products;
 * generation rejects an unpublished dependency before publishing a broken closure.
 * It is a header-free JSON projection on purpose: the
 * `genie` that checks it in CI is the pinned product of an earlier commit, so
 * the output must not depend on header rules introduced by the same change.
 */
const buckProductSourceEntries = [
  ...javascriptProducts.map(([name, outputName, packagePath, targetName, packageTreePath]) => ({
    kind: 'javascript' as const,
    name,
    outputName,
    packagePath,
    packageTreePath: packageTreePath ?? packagePath,
    target: `effect_utils//${packagePath}:${targetName}`,
    version: '0.0.0',
  })),
  ...packageEntries,
].toSorted((left, right) => left.name.localeCompare(right.name))

export default projectionArtifact.json({
  schemaVersion: 1,
  data: buckProductSourceEntries,
  project: (products) => ({
    products,
    schema: 'effect-utils/buck-cache-targets/v1',
  }),
})
