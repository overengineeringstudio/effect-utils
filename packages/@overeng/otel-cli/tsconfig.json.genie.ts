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
    types: ['node', 'bun'],
  },
  include: ['src/**/*', 'bin/**/*'],
  references: [{ path: '../tui-core' }, { path: '../tui-react' }, { path: '../utils' }],
} satisfies TSConfigArgs)
