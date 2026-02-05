import { pnpmWorkspaceWithDeps } from '../../../genie/internal.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceWithDeps({ pkg, deps: [notionEffectSchemaPkg, utilsDevPkg, utilsPkg] })
