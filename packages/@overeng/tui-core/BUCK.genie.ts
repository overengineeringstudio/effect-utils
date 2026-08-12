import { buck2Projection } from '../../../genie/buck2/mod.ts'
import {
  discoverPackageSources,
  packagePath,
  regenerationCommand,
  semanticInputs,
  targetForSources,
} from './buck2/target.ts'

const target = targetForSources(discoverPackageSources(new URL('./', import.meta.url)))

export default buck2Projection.packageFile({
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
