import { pnpmWorkspace } from '../../../genie/internal.ts'

// effect-path has no workspace deps - standalone package
export default pnpmWorkspace('.')
