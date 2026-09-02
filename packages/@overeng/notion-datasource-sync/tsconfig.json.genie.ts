import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
  reactJsx,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    ...reactJsx,
    lib: ['ES2023'],
  },
  include: ['src/**/*'],
  references: [
    { path: '../notion-core' },
    { path: '../notion-effect-client' },
    { path: '../notion-effect-schema' },
    { path: '../notion-md' },
    { path: '../notion-property-write' },
    { path: '../utils' },
  ],
} satisfies TSConfigArgs)
