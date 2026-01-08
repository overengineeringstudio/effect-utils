import { domLib } from '../../genie/repo.ts'
import { tsconfigJSON } from '../../packages/@overeng/genie/src/lib/mod.ts'

export default tsconfigJSON({
  extends: '../../tsconfig.base.json',
  compilerOptions: {
    composite: true,
    rootDir: '.',
    noEmit: true,
    tsBuildInfoFile: './tsconfig.tsbuildinfo',
    lib: [...domLib],
    types: ['node'],
    jsx: 'react-jsx',
    jsxImportSource: '@opentui/react',
  },
  include: ['examples/**/*.tsx'],
  exclude: ['*.genie.ts'],
})
