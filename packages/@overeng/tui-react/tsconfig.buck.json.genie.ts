import { tsconfigJsonForNodeModules, type TSConfigArgs } from '../genie/src/runtime/mod.ts'
import tuiReactTsconfig from './tsconfig.json.genie.ts'

export default tsconfigJsonForNodeModules({
  compilerOptions: tuiReactTsconfig.data.compilerOptions,
  include: tuiReactTsconfig.data.include,
} satisfies TSConfigArgs)
