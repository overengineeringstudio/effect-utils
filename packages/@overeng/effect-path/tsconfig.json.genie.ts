import { packageTsconfigCompilerOptions } from '../../../genie/repo.ts'
import { tsconfigJSON } from '../genie/src/runtime/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    ...packageTsconfigCompilerOptions,
    lib: ['ES2023'],
  },
  include: ['src/**/*'],
})
