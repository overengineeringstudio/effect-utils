import { buck2Projection } from '../../../genie/buck2/mod.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'
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
  semanticInputs: [...semanticInputs, 'packages/@overeng/tui-core/BUCK.genie.ts'],
  regenerationCommand,
  source: 'packages/@overeng/tui-core/BUCK.genie.ts',
})

export default createGenieOutput({
  data: {
    package: packageOutput.data,
  },
  stringify: (context) =>
    `${packageOutput.stringify(context)}\nfilegroup(\n    name = "production_sources",\n    srcs = glob(["src/**/*.ts", "src/**/*.tsx", "package.json", "tsconfig.json"], exclude = ["src/**/*.test.ts", "src/**/*.test.tsx"]),\n    visibility = ["PUBLIC"],\n)\n\nfilegroup(\n    name = "project_sources",\n    srcs = glob(["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "test/**/*.tsx", "package.json", "tsconfig.json"]),\n    visibility = ["PUBLIC"],\n)\n`,
})
