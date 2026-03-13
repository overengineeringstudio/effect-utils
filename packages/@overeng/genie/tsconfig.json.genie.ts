import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from './src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    types: ['node', 'bun'],
    jsx: 'react-jsx',
  },
  include: ['src/**/*.ts', 'src/**/*.tsx', 'bin/**/*.ts', 'bin/**/*.tsx', '../../../types/css.d.ts'],
  references: [
    { path: '../tui-core' },
    { path: '../tui-react' },
    { path: '../utils' },
    { path: '../utils-dev' },
  ],
} satisfies TSConfigArgs)
