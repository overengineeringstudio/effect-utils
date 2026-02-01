import { pnpmWorkspaceReact } from '../../../genie/internal.ts'

// Only include the workspace deps megarepo actually uses
// Using specific packages instead of ../* keeps the lockfile minimal for Nix builds
export default pnpmWorkspaceReact([
  '../utils',
  '../effect-path',
  '../tui-react',
  '../tui-core',
])
