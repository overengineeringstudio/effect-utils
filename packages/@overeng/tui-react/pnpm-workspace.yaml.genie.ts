import { pnpmWorkspaceWithDepsReact } from '../../../genie/internal.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceWithDepsReact({
  pkg,
  deps: [tuiCorePkg],
  extraPackages: ['../utils-dev'],
})
