import { pnpmWorkspaceReact } from '../../../genie/internal.ts'

// Include workspace deps that genie needs
// Using specific packages instead of ../* keeps the lockfile minimal for Nix builds
export default pnpmWorkspaceReact(['../utils', '../tui-react', '../tui-core'])
