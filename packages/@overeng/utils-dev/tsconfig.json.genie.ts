import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
} from '../../../genie/internal.ts'
import { tsconfigJson } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
  },
  include: ['src/**/*'],
})
