import {
  baseTsconfigCompilerOptions,
  domLib,
  packageTsconfigCompilerOptions,
  nodeTypes,
  reactJsx,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    ...reactJsx,
    lib: domLib,
  },
  include: ['src/**/*', 'test/**/*', 'examples/**/*'],
  references: [{ path: '../tui-core' }, { path: '../utils' }, { path: '../utils-dev' }],
} satisfies TSConfigArgs)
