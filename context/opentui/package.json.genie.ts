import { catalogRef } from '../../genie/repo.ts'
import { packageJSON } from '../../packages/@overeng/genie/src/lib/mod.ts'

export default packageJSON({
  name: 'opentui-examples',
  private: true,
  type: 'module',
  dependencies: {
    '@effect-atom/atom': '0.4.11',
    '@effect-atom/atom-react': '0.4.4',
    '@opentui/core': '0.1.68',
    '@opentui/react': '0.1.68',
    effect: catalogRef,
    react: catalogRef,
  },
  devDependencies: {
    '@types/node': catalogRef,
    '@types/react': catalogRef,
  },
})
