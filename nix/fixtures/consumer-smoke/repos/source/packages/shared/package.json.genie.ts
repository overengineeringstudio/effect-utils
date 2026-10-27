import { packageJson } from '../../../../../../../genie/external.ts'
import { firstPartyPackageDefaults } from '../../../../../../../genie/internal.ts'

export default packageJson({
  name: '@fixture/shared',
  ...firstPartyPackageDefaults,
  version: '1.0.0',
  main: 'index.cjs',
  private: true,
})
