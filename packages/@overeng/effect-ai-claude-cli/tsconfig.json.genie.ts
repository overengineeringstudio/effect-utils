import {
  baseTsconfigCompilerOptions,
  domLib,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    lib: domLib,
  },
  include: ['src/**/*'],
})
