import { rootWorkspacePackages } from './package.json.genie.ts'
import type { TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'
import { tsconfigJsonFromPackages } from './packages/@overeng/genie/src/runtime/node/tsconfig-from-packages.ts'

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJsonFromPackages({
  dir: import.meta.dirname,
  packages: rootWorkspacePackages,
  repoName: 'effect-utils',
  files: [],
  extraReferences: ['packages/@overeng/react-inspector/tsconfig.strict-consumer.json'],
} satisfies TSConfigArgs)
