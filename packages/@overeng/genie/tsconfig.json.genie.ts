import { packageTsconfigCompilerOptions } from '../../../genie/repo.ts'
import { tsconfigJSON } from './src/runtime/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    ...packageTsconfigCompilerOptions,
    types: ['node', 'bun'],
  },
  include: ['src/**/*.ts', 'bin/**/*.ts'],
})
