import { workspaceRoot } from './genie/internal.ts'
import { workspaceMemberPaths } from './genie/packages.ts'

export default workspaceRoot({
  name: 'effect-utils-workspace',
  private: true,
  packageManager: 'pnpm@10.28.0',
  workspaces: [...workspaceMemberPaths],
})
