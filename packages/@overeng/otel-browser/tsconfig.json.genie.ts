import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  domLib,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    lib: [...domLib],
    types: ['node', 'bun'],
    noEmit: true,
  },
  include: ['src/**/*'],
  exclude: ['src/**/*.genie.ts'],
} satisfies TSConfigArgs)
