import { tsconfigJSON } from '../packages/@overeng/genie/src/lib/mod.ts'

export default tsconfigJSON({
  extends: '../tsconfig.base.json',
  compilerOptions: {
    composite: true,
    rootDir: '.',
    noEmit: true,
    tsBuildInfoFile: './tsconfig.tsbuildinfo',
    lib: ['ES2022'],
    types: ['node'],
  },
  include: ['**/*.ts'],
  exclude: ['*.genie.ts'],
})
