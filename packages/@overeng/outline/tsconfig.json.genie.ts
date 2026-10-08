import {
  baseTsconfigCompilerOptions,
  domLib,
  packageTsconfigCompilerOptions,
  reactJsx,
  tsconfigJson,
  type TSConfigArgs,
} from '../../../genie/internal.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...reactJsx,
    jsxImportSource: 'react',
    lib: [...domLib],
    noEmit: true,
  },
  include: ['src/**/*'],
} satisfies TSConfigArgs)
