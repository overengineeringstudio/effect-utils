import { baseTsconfigCompilerOptions, domLib } from '../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

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
  },
  include: ['examples/**/*.tsx'],
  exclude: ['*.genie.ts'],
} satisfies TSConfigArgs)
