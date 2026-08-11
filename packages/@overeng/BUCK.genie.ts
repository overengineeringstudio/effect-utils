import { createGenieOutput } from './genie/src/runtime/core.ts'
import {
  megarepoRuntimeAnalyzerVersion,
  megarepoRuntimeSemanticFingerprint,
  megarepoRuntimeSourcesByPackage,
} from './megarepo/BUCK.genie.ts'

const packageNames = [
  'content-address',
  'effect-distributed-lock',
  'effect-path',
  'kdl',
  'kdl-effect',
  'otel-contract',
  'tui-react',
  'utils',
  'utils-dev',
] as const

const sourcePatterns = (packageName: string): readonly string[] => [
  `${packageName}/package.json`,
  `${packageName}/tsconfig.json`,
  `${packageName}/src/**/*.cts`,
  `${packageName}/src/**/*.mts`,
  `${packageName}/src/**/*.ts`,
  `${packageName}/src/**/*.tsx`,
]

const excludedPatterns = (packageName: string): readonly string[] => [
  `${packageName}/src/**/*.test.ts`,
  `${packageName}/src/**/*.test.tsx`,
  `${packageName}/src/**/*.stories.ts`,
  `${packageName}/src/**/*.stories.tsx`,
  `${packageName}/src/**/stories/**`,
  `${packageName}/src/test-utils/**`,
]

const renderList = (values: readonly string[]): string =>
  values.map((value) => `        ${JSON.stringify(value)},`).join('\n')

const productionTargets = packageNames
  .map(
    (packageName) => `filegroup(
    name = ${JSON.stringify(`${packageName}_production_sources`)},
    srcs = glob(
        [
${renderList(sourcePatterns(packageName))}
        ],
        exclude = [
${renderList(excludedPatterns(packageName))}
        ],
    ),
    visibility = ["PUBLIC"],
)`,
  )
  .join('\n\n')

const runtimeTargets = Object.entries(megarepoRuntimeSourcesByPackage)
  .filter(([packageName]) => packageName !== 'megarepo' && packageName !== 'tui-core')
  .map(
    ([packageName, sources]) => `filegroup(
    name = ${JSON.stringify(`${packageName}_megarepo_runtime_sources`)},
    srcs = [
${renderList(sources.map((source) => `${packageName}/${source}`))}
    ],
    visibility = ["PUBLIC"],
)`,
  )
  .join('\n\n')

const rendered = `# Megarepo runtime closure analyzer: bun ${megarepoRuntimeAnalyzerVersion}, pinned by flake.lock
# Megarepo runtime closure semantic fingerprint: sha256:${megarepoRuntimeSemanticFingerprint}
${productionTargets}\n\n${runtimeTargets}\n`

export default createGenieOutput({
  data: {
    megarepoRuntimeAnalyzerVersion,
    megarepoRuntimeSemanticFingerprint,
    megarepoRuntimeSourcesByPackage,
    packageNames,
  },
  stringify: () => rendered,
})
