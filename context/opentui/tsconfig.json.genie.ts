import { domLib } from '../../genie/repo.ts'
import { tsconfigJSON } from '../../packages/@overeng/genie/src/runtime/mod.ts'

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
    /** OpenTUI re-exports use extensionless paths that NodeNext can't resolve. https://github.com/anomalyco/opentui/issues/504 */
    moduleResolution: 'Bundler',
    module: 'ESNext',
  },
  include: ['examples/**/*.tsx'],
  exclude: ['*.genie.ts'],
})
