import { rootWorkspaceExtraMembers, rootWorkspacePackages } from './package.json.genie.ts'
import {
  tsconfigJsonFromPackages,
  type TSConfigArgs,
} from './packages/@overeng/genie/src/runtime/mod.ts'

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJsonFromPackages({
  dir: import.meta.dirname,
  packages: rootWorkspacePackages,
  extraReferences: rootWorkspaceExtraMembers,
  files: [],
} satisfies TSConfigArgs)
