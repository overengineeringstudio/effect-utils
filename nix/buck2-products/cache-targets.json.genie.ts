import { readFileSync } from 'node:fs'

import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const javascriptProducts = [
  ['ci-tools', 'ci-tools.js', 'packages/@overeng/ci-tools', 'ci-tools-candidate'],
  ['genie', 'genie.js', 'packages/@overeng/genie', 'genie-candidate'],
  [
    'genie-bootstrap-closure-check',
    'genie-bootstrap-closure-check.js',
    'packages/@overeng/genie',
    'genie-bootstrap-closure-check-candidate',
  ],
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
  '@overeng/content-address',
  '@overeng/effect-distributed-lock',
  '@overeng/notion-core',
  '@overeng/notion-effect-client',
  '@overeng/notion-effect-schema',
  '@overeng/otel-contract',
  '@overeng/restate-effect',
  '@overeng/tui-core',
  '@overeng/tui-react',
  '@overeng/utils',
  '@overeng/utils-dev',
] as const

const packageEntries = packageProducts.map((name) => {
  const packagePath = `packages/${name}`
  const packageJson = JSON.parse(readFileSync(`${packagePath}/package.json`, 'utf8')) as {
    readonly version: string
  }
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
 * the two cannot drift. It is a header-free JSON projection on purpose: the
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
