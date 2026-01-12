import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
  },
  include: ['src/**/*', 'bin/**/*.ts'],
  references: [
    { path: '../notion-effect-client' },
    { path: '../notion-effect-schema' },
    { path: '../utils' },
  ],
})
