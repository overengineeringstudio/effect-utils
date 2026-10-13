import { baseTsconfigCompilerOptions, nodeTypes, tsconfigJson } from '../../genie/internal.ts'

// The harnesses are bundled or type-stripped, not published as a workspace package.
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...nodeTypes,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2024', 'ESNext.Disposable', 'DOM'],
    noEmit: true,
  },
  include: ['**/*.ts'],
  exclude: ['**/*.genie.ts'],
})
