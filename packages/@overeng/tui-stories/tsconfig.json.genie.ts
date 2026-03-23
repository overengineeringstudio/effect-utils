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
  include: ['src/**/*', 'test/**/*', 'bin/**/*.ts', 'bin/**/*.tsx', '../../../types/css.d.ts'],
  exclude: ['src/**/stories/_megarepo-renders.ts'],
  references: [
    { path: '../megarepo' },
    { path: '../tui-core' },
    { path: '../tui-react' },
    { path: '../utils' },
    { path: '../utils-dev' },
  ],
} satisfies TSConfigArgs)
