// @genie-bootstrap
import {
  catalog,
  packageJson,
  workspaceMember,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const composition = catalog.compose({
  workspace: workspaceMember({ memberPath: 'context/effect/socket' }),
  dependencies: {
    // Effect 4: platform and rpc live in core (`effect` / `effect/unstable/*`);
    // only the platform-node runtime package remains separate.
    external: catalog.pick('effect', '@effect/platform-node'),
  },
  devDependencies: {
    external: catalog.pick('@types/node'),
  },
})

export default packageJson(
  {
    name: 'effect-socket-examples',
    private: true,
    type: 'module',
  } satisfies PackageJsonData,
  composition,
)
