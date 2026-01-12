import { tsconfigJSON } from '../genie/src/runtime/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    composite: true,
    rootDir: '.',
    outDir: './dist',
    tsBuildInfoFile: './tsconfig.tsbuildinfo',
  },
  include: ['src/**/*.ts'],
})
