import { rootTsconfigProjects } from './genie/tsconfig-projects.ts'
import type { TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'
import { tsconfigJson } from './packages/@overeng/genie/src/runtime/mod.ts'

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJson({
  files: [],
  references: rootTsconfigProjects
    .map((project) => ({ path: `./${project.path}` }))
    .toSorted((a, b) => a.path.localeCompare(b.path)),
} satisfies TSConfigArgs)
