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
    lib: ['ES2023'],
  },
  include: ['src/**/*'],
  references: [
    { path: '../content-address' },
    { path: '../notion-core' },
    { path: '../notion-effect-client' },
    { path: '../notion-effect-schema' },
    { path: '../notion-md' },
    { path: '../tui-react' },
    { path: '../utils' },
  ],
} satisfies TSConfigArgs)
