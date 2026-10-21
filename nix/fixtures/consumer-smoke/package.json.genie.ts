import { projectionArtifact } from '../../../genie/external.ts'
import rootPackageJson from '../../../package.json.genie.ts'

// This is an independent consumer input, not an effect-utils workspace package.
export default projectionArtifact.json({
  schemaVersion: 1,
  data: {
    name: '@fixture/consumer',
    version: '1.0.0',
    private: true,
    packageManager: rootPackageJson.data.packageManager,
    dependencies: {
      '@fixture/shared': 'file:.devenv/pnpm-source-inputs/current/repos/source/packages/shared',
    },
  },
})
