import { isTsconfigReferenceTarget } from './packages/@overeng/genie/src/runtime/composition/mod.ts'
import { tsconfigJson, type TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'
import { rootTsconfigProjects } from './genie/tsconfig-projects.ts'

export default tsconfigJson({
  files: [],
  references: rootTsconfigProjects
    .filter((project) => isTsconfigReferenceTarget(project.tsconfig.data))
    .map((project) => ({ path: `./${project.path}` }))
    .toSorted((a, b) => a.path.localeCompare(b.path)),
} satisfies TSConfigArgs)
