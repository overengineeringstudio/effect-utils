import { baseTsconfigCompilerOptions, tsconfigJson } from '../../genie/repo.ts'
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    preserveSymlinks: true,
    tsBuildInfoFile: './dist/tsconfig.tsbuildinfo',
    rootDir: '../..',
    outDir: 'dist',
    types: ['node'],
  },
  include: ['src/**/*', 'generated/**/*', 'rust/*.ts'],
  exclude: ['negative', '**/*.genie.ts'],
  references: [{ path: '../schema-registry' }],
})
