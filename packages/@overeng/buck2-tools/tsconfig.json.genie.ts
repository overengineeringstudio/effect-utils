import {
  baseTsconfigCompilerOptions,
  nodeTypes,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    lib: ['ES2024', 'DOM', 'DOM.Iterable', 'DOM.AsyncIterable'],
    types: ['node', 'bun'],
    noEmit: true,
  },
  include: ['src/**/*'],
  references: [],
} satisfies TSConfigArgs)
