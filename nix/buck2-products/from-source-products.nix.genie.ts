import { readFileSync } from 'node:fs'

import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

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
  ['tui-stories', 'tui-stories.js', 'packages/@overeng/tui-stories', 'tui-stories-candidate'],
] as const

const packageProducts = [
  '@overeng/content-address',
  '@overeng/effect-distributed-lock',
  '@overeng/notion-core',
  '@overeng/notion-effect-client',
  '@overeng/notion-effect-schema',
  '@overeng/otel-contract',
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
export const buckProductSourceEntries = [
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

const nixString = (value: string): string => JSON.stringify(value)

export default createGenieOutput({
  data: buckProductSourceEntries,
  stringify: () =>
    `${[
      '{',
      '  mkBuckProductFromSource,',
      '  preparedDeps,',
      '  producerCommit,',
      '  repositoryRoot ? ../..,',
      '}:',
      '',
      '{',
      ...buckProductSourceEntries.flatMap((entry) => [
        `  ${nixString(entry.name)} = mkBuckProductFromSource {`,
        '    product = {',
        `      kind = ${nixString(entry.kind)};`,
        `      name = ${nixString(entry.name)};`,
        `      outputName = ${nixString(entry.outputName)};`,
        `      packagePath = ${nixString(entry.packagePath)};`,
        `      packageTreePath = ${nixString(entry.packageTreePath)};`,
        `      target = ${nixString(entry.target)};`,
        `      version = ${nixString(entry.version)};`,
        '    };',
        '    inherit preparedDeps;',
        '    inherit producerCommit repositoryRoot;',
        '  };',
      ]),
      '}',
    ].join('\n')}\n`,
})
