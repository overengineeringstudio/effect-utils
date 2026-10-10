import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
  tsconfigJson,
} from '../../../genie/internal.ts'

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
})
