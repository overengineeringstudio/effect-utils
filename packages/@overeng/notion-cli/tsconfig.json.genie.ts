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
  },
  include: ['src/**/*', 'bin/**/*.ts'],
  references: [
    { path: '../notion-effect-client' },
    { path: '../notion-effect-schema' },
    { path: '../tui-react' },
    { path: '../utils' },
  ],
})
