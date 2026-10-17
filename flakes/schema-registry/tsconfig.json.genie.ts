import { baseTsconfigCompilerOptions, tsconfigJson } from '../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    tsBuildInfoFile: './dist/tsconfig.tsbuildinfo',
    rootDir: '.',
    outDir: 'dist',
    types: ['node'],
  },
  include: ['src/**/*'],
})
