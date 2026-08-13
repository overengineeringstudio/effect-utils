import { createGenieOutput } from './genie/src/runtime/core.ts'
import { workspacePackages } from './megarepo/buck2/workspace-packages.ts'

const sourceExtensions = ['cts', 'mts', 'ts', 'tsx'] as const
const productionPatterns = [
  'package.json',
  'tsconfig.json',
  'src/**/*.cts',
  'src/**/*.mts',
  'src/**/*.ts',
  'src/**/*.tsx',
] as const
type TsconfigOutput = {
  readonly data: {
    readonly include?: readonly string[]
    readonly exclude?: readonly string[]
  }
}
const expandTypeScriptPattern = (pattern: string): readonly string[] => {
  if (sourceExtensions.some((extension) => pattern.endsWith(`.${extension}`)) === true)
    return [pattern]
  if (pattern.endsWith('*') === true)
    return sourceExtensions.map((extension) => `${pattern}.${extension}`)
  throw new Error(`Unsupported tsconfig source pattern for Buck projection: ${pattern}`)
}
const projectPatterns = (tsconfig: TsconfigOutput): readonly string[] => [
  'package.json',
  'tsconfig.json',
  ...(tsconfig.data.include ?? []).flatMap(expandTypeScriptPattern),
]
const projectExcludes = (tsconfig: TsconfigOutput): readonly string[] =>
  (tsconfig.data.exclude ?? []).flatMap(expandTypeScriptPattern)
const productionExcludes = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/**/*.stories.ts',
  'src/**/*.stories.tsx',
  'src/**/stories/**',
  'src/test-utils/**',
] as const
const renderTarget = ({
  name,
  role,
  patterns,
  exclude,
}: {
  name: string
  role: string
  patterns: readonly string[]
  exclude: readonly string[]
}): string => `filegroup(
    name = ${JSON.stringify(`${name}_${role}_sources`)},
    srcs = glob([${patterns.map((path) => `\n        ${JSON.stringify(`${name}/${path}`)},`).join('')}\n    ]${exclude.length === 0 ? '' : `, exclude = [${exclude.map((path) => `\n        ${JSON.stringify(`${name}/${path}`)},`).join('')}\n    ]`}),
    visibility = ["PUBLIC"],
)`
const rendered = Object.entries(workspacePackages)
  .filter(([name]) => name !== '@overeng/tui-core')
  .flatMap(([fullName, { tsconfig }]) => {
    const name = fullName.slice('@overeng/'.length)
    return [
      renderTarget({
        name,
        role: 'production',
        patterns: productionPatterns,
        exclude: productionExcludes,
      }),
      renderTarget({
        name,
        role: 'project',
        patterns: projectPatterns(tsconfig),
        exclude: projectExcludes(tsconfig),
      }),
    ]
  })
  .join('\n\n')

export default createGenieOutput({
  data: { packageNames: Object.keys(workspacePackages) },
  stringify: () => `${rendered}\n`,
})
