import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  reactJsx,
} from '../../../genie/internal.ts'
import { tsconfigJson } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...reactJsx,
    types: ['node', 'bun'],
  },
  include: ['src/**/*', 'test/**/*'],
  references: [{ path: '../tui-react' }],
})
