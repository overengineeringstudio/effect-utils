import { pnpmWorkspaceWithDepsReact } from '../../../genie/internal.ts'
import effectPathPkg from '../effect-path/package.json.genie.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceWithDepsReact({
  pkg,
  deps: [effectPathPkg, tuiCorePkg, tuiReactPkg, utilsPkg],
})
