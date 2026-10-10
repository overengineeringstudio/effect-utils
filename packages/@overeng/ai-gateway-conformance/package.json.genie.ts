// @genie-bootstrap
import { readdirSync } from 'node:fs'

import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const caseExports = Object.fromEntries(
  readdirSync(new URL('./cases/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() === true && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .toSorted()
    .map((file) => [`./cases/${file}`, `./cases/${file}`]),
)

export default packageJson(
  {
    name: '@overeng/ai-gateway-conformance',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      ...caseExports,
      './case.schema.json': './case.schema.json',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        ...caseExports,
        './case.schema.json': './case.schema.json',
      },
    },
  } satisfies PackageJsonInputData,
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/ai-gateway-conformance' }),
    devDependencies: {
      external: catalog.pick('@types/node', 'typescript', 'effect'),
    },
    peerDependencies: { external: catalog.pick('effect') },
  }),
)
