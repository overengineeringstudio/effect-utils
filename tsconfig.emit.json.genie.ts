import {
  isRootTsconfigEmitProject,
  rootTsconfigProjects,
} from './genie/tsconfig-projects.ts'
import { tsconfigJson, type TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

export default tsconfigJson({
  files: [],
  references: rootTsconfigProjects
    .filter(isRootTsconfigEmitProject)
    .map((project) => ({ path: `./${project.path}` }))
    .toSorted((a, b) => a.path.localeCompare(b.path)),
} satisfies TSConfigArgs)
