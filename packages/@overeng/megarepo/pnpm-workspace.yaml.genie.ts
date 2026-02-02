import { pnpmWorkspaceReactFromPackageJson } from '../../../genie/internal.ts'
import pkg from './package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'

// Only include the workspace deps megarepo actually uses
// Using specific packages instead of ../* keeps the lockfile minimal for Nix builds
export default pnpmWorkspaceReactFromPackageJson(pkg, {
  include: [tuiReactPkg],
})
