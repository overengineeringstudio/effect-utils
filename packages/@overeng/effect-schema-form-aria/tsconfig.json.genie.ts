import { domLib, packageTsconfigCompilerOptions, reactJsx } from '../../../genie/repo.ts'
import { tsconfigJSON } from '../genie/src/runtime/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    ...packageTsconfigCompilerOptions,
    ...reactJsx,
    lib: [...domLib],
  },
  include: ['src/**/*'],
  references: [{ path: '../effect-schema-form' }],
})
