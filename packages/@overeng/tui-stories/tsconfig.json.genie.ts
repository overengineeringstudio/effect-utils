import {
  baseTsconfigCompilerOptions,
  nodeTypes,
  packageTsconfigCompilerOptions,
  reactJsx,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    ...reactJsx,
  },
  include: ['src/**/*', 'test/**/*', 'bin/**/*.ts', 'bin/**/*.tsx'],
  references: [{ path: '../megarepo' }, { path: '../utils' }],
} satisfies TSConfigArgs)
