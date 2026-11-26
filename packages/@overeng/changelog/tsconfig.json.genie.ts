import {
  baseTsconfigCompilerOptions,
  domLib,
  nodeTypes,
  packageTsconfigCompilerOptions,
  tsconfigJson,
  type TSConfigArgs,
} from '../../../genie/internal.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    // The renderer injects its overlay into the page under test.
    lib: [...domLib],
    noEmit: true,
  },
  include: ['src/**/*'],
} satisfies TSConfigArgs)
