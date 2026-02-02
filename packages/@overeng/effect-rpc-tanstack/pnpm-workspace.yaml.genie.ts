import { pnpmWorkspaceReact } from '../../../genie/internal.ts'

// Include workspace deps that examples/basic needs
export default pnpmWorkspaceReact(['examples/basic', '../utils'])
