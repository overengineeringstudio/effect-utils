import { workspaceReferences } from './genie/repo.ts'
import { tsconfigJSON } from './packages/@overeng/genie/src/lib/mod.ts'

export default tsconfigJSON({
  extends: './tsconfig.base.json',
  references: workspaceReferences.map((path) => ({ path })),
  files: [],
})
