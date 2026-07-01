import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from './src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    types: ['node', 'bun'],
    jsx: 'react-jsx',
  },
  include: ['src/**/*.ts', 'src/**/*.tsx', 'bin/**/*.ts', 'bin/**/*.tsx'],
  references: [
    { path: '../ci-tools' },
    { path: '../otel-contract' },
    { path: '../tui-core' },
    { path: '../tui-react' },
    { path: '../utils' },
    { path: '../utils-dev' },
  ],
} satisfies TSConfigArgs)
