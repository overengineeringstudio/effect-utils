import { pnpmWorkspaceReactFromPackageJson } from '../../../genie/internal.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import pkg from './package.json.genie.ts'

// Include workspace deps that genie needs
// Using specific packages instead of ../* keeps the lockfile minimal for Nix builds
export default pnpmWorkspaceReactFromPackageJson(pkg, {
  include: [tuiReactPkg],
})
