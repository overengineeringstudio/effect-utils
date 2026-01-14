import { baseTsconfigCompilerOptions, domLib } from '../../genie/internal.ts'
import { tsconfigJson } from '../../packages/@overeng/genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    rootDir: '.',
    noEmit: true,
    tsBuildInfoFile: './dist/tsconfig.tsbuildinfo',
    lib: [...domLib],
    types: ['node'],
    jsx: 'react-jsx',
    jsxImportSource: '@opentui/react',
    /** OpenTUI re-exports use extensionless paths that NodeNext can't resolve. https://github.com/anomalyco/opentui/issues/504 */
    moduleResolution: 'Bundler',
    module: 'ESNext',
  },
  include: ['examples/**/*.tsx'],
  exclude: ['*.genie.ts'],
})
