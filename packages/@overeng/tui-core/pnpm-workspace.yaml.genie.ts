import { pnpmWorkspace } from '../../../genie/internal.ts'

// tui-core has no workspace deps - standalone package
export default pnpmWorkspace('.')
