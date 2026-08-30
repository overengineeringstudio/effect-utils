// @genie-bootstrap
import { catalog, packageJson, privatePackageDefaults } from '../../../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/pnpm-lock-projector',
  ...privatePackageDefaults,
  dependencies: catalog.pick('@pnpm/lockfile.fs', '@pnpm/lockfile.pruner'),
})
