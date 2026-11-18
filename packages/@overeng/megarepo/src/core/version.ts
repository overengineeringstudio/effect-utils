import { resolveCliIdentity } from '@overeng/utils/node/cli-version'

import packageJson from '../../package.json' with { type: 'json' }

/** Package version used in generated outputs. */
export const MR_VERSION = packageJson.version

/** Shared by the executable and the exported CLI runner. */
export const mrIdentity = resolveCliIdentity({
  name: 'megarepo',
  namespace: 'overeng',
  baseVersion: MR_VERSION,
  buildStamp: '__CLI_BUILD_STAMP__',
})
