import { pnpmWorkspace } from '../../../genie/internal.ts'

// cli-ui has no workspace deps - standalone package
export default pnpmWorkspace('.')
