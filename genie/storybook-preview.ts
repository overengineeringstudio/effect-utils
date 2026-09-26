/**
 * Shared configuration for the split Storybook preview workflows:
 * - `.github/workflows/storybook-preview-build.yml` (uncredentialed `pull_request`)
 * - `.github/workflows/storybook-preview-deploy.yml` (trusted `workflow_run`)
 */
import {
  cachixCliBuildStep,
  cachixStep,
  installNixStep,
  namespaceRunner,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  readBinaryCacheDescriptors,
  validateNixStoreStep,
} from './ci-workflow.ts'

/** Must match the build workflow `name:`; the deploy workflow triggers on it. */
export const storybookPreviewBuildWorkflowName = 'Storybook Preview Build'

export const storybookPreviewRunner = namespaceRunner({
  profile: 'namespace-profile-linux-x86-64',
  runId: '${{ github.run_id }}',
})

const binaryCache = readBinaryCacheDescriptors(
  new URL('../nix/binary-caches.json', import.meta.url),
)['overeng-effect-utils']!

/** Nix + devenv setup after checkout. Read-only caches; no secrets. */
export const storybookPreviewSetupSteps = [
  installNixStep({ binaryCaches: [binaryCache] }),
  cachixCliBuildStep,
  cachixStep({ name: 'overeng-effect-utils' }),
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  validateNixStoreStep,
] as const
