import {
  baseTsconfigCompilerOptions,
  domLib,
  packageTsconfigCompilerOptions,
  reactJsx,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...reactJsx,
    lib: domLib,
  },
  include: ['src/**/*', 'test/**/*', 'examples/**/*'],
  references: [{ path: '../tui-core' }, { path: '../utils' }],
} satisfies TSConfigArgs)
