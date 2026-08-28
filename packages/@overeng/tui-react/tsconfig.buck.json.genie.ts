import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'
import tuiReactTsconfig from './tsconfig.json.genie.ts'

export default tsconfigJson(
  {
    compilerOptions: tuiReactTsconfig.data.compilerOptions,
    include: tuiReactTsconfig.data.include,
  } satisfies TSConfigArgs,
  { workspaceDependencyResolution: 'node-modules' },
)
