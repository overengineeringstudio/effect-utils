import { buck2Projection } from '../../../genie/buck2/mod.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'
import {
  megarepoRuntimeAnalyzerVersion,
  megarepoRuntimeSemanticFingerprint,
  megarepoRuntimeSourcesByPackage,
} from '../megarepo/BUCK.genie.ts'
import {
  discoverPackageSources,
  packagePath,
  regenerationCommand,
  semanticInputs,
  targetForSources,
} from './buck2/target.ts'

const target = targetForSources(discoverPackageSources(new URL('./', import.meta.url)))

const packageOutput = buck2Projection.packageFile({
  packagePath,
  macro: {
    load: '//buck2:package_targets.bzl',
    symbol: 'package_task',
  },
  targets: [target],
  semanticInputs,
  regenerationCommand,
})

const productionSources = discoverPackageSources(new URL('./', import.meta.url)).filter(
  (source) => source.startsWith('src/') && source.includes('.test.') === false,
)

export default createGenieOutput({
  data: {
    megarepoRuntimeSources: megarepoRuntimeSourcesByPackage['tui-core'],
    megarepoRuntimeAnalyzerVersion,
    megarepoRuntimeSemanticFingerprint,
    package: packageOutput.data,
    productionSources,
  },
  stringify: (context) =>
    `${packageOutput.stringify(context)}\n# Megarepo runtime closure analyzer: bun ${megarepoRuntimeAnalyzerVersion}, pinned by flake.lock
# Megarepo runtime closure semantic fingerprint: sha256:${megarepoRuntimeSemanticFingerprint}
filegroup(\n    name = "production_sources",\n    srcs = [\n${productionSources.map((source) => `        ${JSON.stringify(source)},`).join('\n')}\n        "package.json",\n        "tsconfig.json",\n    ],\n    visibility = ["PUBLIC"],\n)\n\nfilegroup(\n    name = "megarepo_runtime_sources",\n    srcs = [\n${(megarepoRuntimeSourcesByPackage['tui-core'] ?? []).map((source) => `        ${JSON.stringify(source)},`).join('\n')}\n    ],\n    visibility = ["PUBLIC"],\n)\n`,
})
