import { rootTsconfigProjects } from './genie/tsconfig-projects.ts'
import { isTsconfigReferenceTarget } from './packages/@overeng/genie/src/runtime/composition/mod.ts'
import type { TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'
import { tsconfigJson } from './packages/@overeng/genie/src/runtime/mod.ts'

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJson({
  files: [],
  references: rootTsconfigProjects
    .filter((project) => isTsconfigReferenceTarget(project.tsconfig.data))
    .map((project) => ({ path: `./${project.path}` }))
    .toSorted((a, b) => a.path.localeCompare(b.path)),
} satisfies TSConfigArgs)
