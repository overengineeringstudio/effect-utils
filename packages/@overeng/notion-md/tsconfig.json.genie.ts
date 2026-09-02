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
    { path: '../content-address' },
    { path: '../notion-core' },
    { path: '../notion-effect-client' },
    { path: '../notion-effect-schema' },
    { path: '../notion-property-write' },
    { path: '../otel-contract' },
    { path: '../utils' },
  ],
} satisfies TSConfigArgs)
