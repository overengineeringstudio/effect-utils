import { pnpmWorkspace } from '../../../genie/internal.ts'

// Only include utils - the one workspace dep genie needs
// Using specific packages instead of ../* keeps the lockfile minimal for Nix builds
export default pnpmWorkspace('../utils')
