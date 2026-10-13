import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    lib: ['ES2024', 'ESNext.Disposable', 'DOM'],
    noEmit: true,
  },
  include: ['src/**/*'],
  references: [],
} satisfies TSConfigArgs)
