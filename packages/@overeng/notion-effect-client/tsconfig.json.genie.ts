import { packageTsconfigCompilerOptions } from '../../../genie/repo.ts'
import { tsconfigJSON } from '../genie/src/runtime/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: packageTsconfigCompilerOptions,
  include: ['src/**/*'],
  references: [{ path: '../notion-effect-schema' }, { path: '../utils' }],
})
