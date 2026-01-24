import {
  baseTsconfigCompilerOptions,
  domLib,
  packageTsconfigCompilerOptions,
  reactJsx,
  reactTypesPathWorkaround,
} from '../../../genie/internal.ts'
import { tsconfigJson } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...reactJsx,
    ...reactTypesPathWorkaround,
    lib: [...domLib],
  },
  include: ['src/**/*'],
  references: [{ path: '../effect-schema-form' }],
})
