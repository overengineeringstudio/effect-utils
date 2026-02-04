import { baseTsconfigCompilerOptions, domLib } from '../../../genie/internal.ts'
import {
  tsconfigJson,
  type TSConfigArgs,
} from '../../../packages/@overeng/genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    rootDir: '.',
    noEmit: true,
    tsBuildInfoFile: './tsconfig.tsbuildinfo',
    lib: [...domLib],
    types: ['node'],
  },
  include: ['examples/**/*.ts'],
  exclude: ['*.genie.ts'],
} satisfies TSConfigArgs)
