import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    types: ['node', 'bun'],
    lib: ['ES2024', 'DOM', 'DOM.Iterable'],
    noEmit: true,
  },
  include: ['src/**/*'],
})
