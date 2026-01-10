import { tsconfigJSON } from '../packages/@overeng/genie/src/lib/mod.ts'

export default tsconfigJSON({
  extends: '../tsconfig.base.json',
  compilerOptions: {
    composite: true,
    rootDir: '.',
    noEmit: true,
    tsBuildInfoFile: './tsconfig.tsbuildinfo',
    lib: ['ES2023'],
    types: ['node'],
  },
  include: ['**/*.ts'],
  exclude: ['*.genie.ts'],
  references: [
    { path: '../packages/@overeng/genie' },
    { path: '../packages/@overeng/mono' },
    { path: '../packages/@overeng/utils' },
  ],
})
