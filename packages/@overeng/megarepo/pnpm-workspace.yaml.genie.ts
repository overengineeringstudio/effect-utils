import { pnpmWorkspace } from '../../../genie/internal.ts'

// Only include the workspace deps megarepo actually uses
// Using specific packages instead of ../* keeps the lockfile minimal for Nix builds
export default pnpmWorkspace(
  '../utils',
  '../cli-ui',
  '../effect-path',
  '../tui-react',
  '../tui-core',
)
