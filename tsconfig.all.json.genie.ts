import { tsconfigJson, type TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'
import { workspaceMemberPaths } from './genie/packages.ts'

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJson({
  references: workspaceMemberPaths.map((path) => ({ path: `./${path}` })),
  files: [],
} satisfies TSConfigArgs)
