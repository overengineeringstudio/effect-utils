import { packageTsconfigCompilerOptions } from '../../../genie/repo.ts'
import { tsconfigJSON } from '../../@overeng/genie/src/runtime/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: packageTsconfigCompilerOptions,
  include: ['src/**/*'],
})
