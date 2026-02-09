import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  reactJsx,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...reactJsx,
    lib: ['ES2024'],
  },
  include: ['src/**/*', 'test/**/*', 'examples/**/*'],
  references: [{ path: '../tui-core' }, { path: '../utils' }],
} satisfies TSConfigArgs)
