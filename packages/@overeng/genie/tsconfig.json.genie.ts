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
    noEmit: true,
    // The bootstrap checker runs before install and from Buck's relocated package tree.
    paths: {
      '@overeng/utils/node/cli-build-identity': [
        '../utils/src/node/cli-build-identity.js',
        './node_modules/@overeng/utils/src/node/cli-build-identity.js',
      ],
    },
  },
  include: ['src/**/*.ts', 'src/**/*.tsx', 'bin/**/*.ts', 'bin/**/*.tsx'],
} satisfies TSConfigArgs)
