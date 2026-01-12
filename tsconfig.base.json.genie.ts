import { baseTsconfigCompilerOptions } from './genie/repo.ts'
import { tsconfigJSON } from './packages/@overeng/genie/src/runtime/mod.ts'

export default tsconfigJSON({
  compilerOptions: baseTsconfigCompilerOptions,
  exclude: ['node_modules', 'dist'],
})
