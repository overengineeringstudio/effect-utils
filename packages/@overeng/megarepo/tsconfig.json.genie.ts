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
  include: ['src/**/*', 'test/**/*', 'bin/**/*', '../../../types/css.d.ts'],
  references: [
    { path: '../tui-core' },
    { path: '../tui-react' },
    { path: '../effect-path' },
    { path: '../utils' },
  ],
} satisfies TSConfigArgs)
