import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
  },
  include: ['src/**/*'],
  references: [{ path: '../notion-effect-schema' }, { path: '../utils' }, { path: '../utils-dev' }],
} satisfies TSConfigArgs)
