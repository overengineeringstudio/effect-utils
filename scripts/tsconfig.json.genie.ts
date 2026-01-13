import { baseTsconfigCompilerOptions } from '../genie/internal.ts'
import { tsconfigJson } from '../packages/@overeng/genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    rootDir: '.',
    noEmit: true,
    tsBuildInfoFile: './tsconfig.tsbuildinfo',
    lib: ['ES2023'],
    types: ['node', 'bun'],
  },
  include: ['**/*.ts'],
  exclude: ['*.genie.ts'],
  references: [
    { path: '../packages/@overeng/genie' },
    { path: '../packages/@overeng/mono' },
    { path: '../packages/@overeng/utils' },
  ],
})
