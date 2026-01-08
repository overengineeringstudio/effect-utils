import { tsconfigJSON } from '@overeng/genie'

import { packageTsconfigCompilerOptions } from '../../../genie/repo.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: packageTsconfigCompilerOptions,
  include: ['src/**/*.ts', 'bin/**/*.ts'],
})
