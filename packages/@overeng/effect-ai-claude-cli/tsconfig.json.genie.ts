import { domLib, packageTsconfigCompilerOptions } from '../../../genie/repo.ts'
import { tsconfigJSON } from '../genie/src/lib/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    ...packageTsconfigCompilerOptions,
    lib: domLib,
  },
  include: ['src/**/*'],
})
