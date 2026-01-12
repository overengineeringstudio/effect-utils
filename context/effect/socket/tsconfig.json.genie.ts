import { domLib } from '../../../genie/repo.ts'
import { tsconfigJSON } from '../../../packages/@overeng/genie/src/runtime/mod.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    composite: true,
    rootDir: '.',
    noEmit: true,
    tsBuildInfoFile: './tsconfig.tsbuildinfo',
    lib: [...domLib],
    types: ['node'],
  },
  include: ['examples/**/*.ts'],
  exclude: ['*.genie.ts'],
})
