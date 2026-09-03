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
  },
  include: ['src/**/*', 'bin/**/*.ts'],
  references: [
    { path: '../effect-path' },
    { path: '../notion-datasource-sync' },
    { path: '../notion-md' },
  ],
} satisfies TSConfigArgs)
