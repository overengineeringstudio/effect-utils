import { rootWorkspaceMemberPaths } from './package.json.genie.ts'
import { tsconfigJson, type TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJson({
  references: rootWorkspaceMemberPaths.map((path) => ({ path: `./${path}` })),
  files: [],
} satisfies TSConfigArgs)
