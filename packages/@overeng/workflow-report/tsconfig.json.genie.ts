import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    types: ['node', 'bun'],
  },
  include: ['src/**/*', 'bin/**/*.ts'],
  references: [{ path: '../utils' }, { path: '../utils-dev' }],
} satisfies TSConfigArgs)
