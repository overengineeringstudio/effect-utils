import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
} from '../../../genie/internal.ts'
import { tsconfigJson } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    jsx: 'react-jsx',
    jsxImportSource: '@opentui/react',
  },
  include: ['src/**/*'],
  references: [{ path: '../utils' }],
})
