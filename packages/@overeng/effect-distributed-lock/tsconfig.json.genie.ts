import {
  baseTsconfigCompilerOptions,
  nodeTypes,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...nodeTypes,
    ...packageTsconfigCompilerOptions,
  },
  include: ['src/**/*'],
  references: [{ path: '../utils-dev' }],
} satisfies TSConfigArgs)
