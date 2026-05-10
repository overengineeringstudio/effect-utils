import {
  cachixStep,
  checkoutStep,
  devenvPerfWorkflow,
  evictCachedPnpmDepsStep,
  installNixStep,
  pnpmStateSetupStep,
  preparePinnedDevenvStep,
  restorePnpmStateStep,
  validateNixStoreStep,
} from '../../genie/ci-workflow.ts'

export default devenvPerfWorkflow({
  setupSteps: [
    checkoutStep(),
    installNixStep(),
    cachixStep({ name: 'overeng-effect-utils', authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}' }),
    preparePinnedDevenvStep,
    pnpmStateSetupStep,
    restorePnpmStateStep(),
    validateNixStoreStep,
    evictCachedPnpmDepsStep({
      flakeRef: '.#oxlint-npm',
      name: 'Evict cached pnpm deps for oxlint-npm',
    }),
  ],
  taskProbes: ['otel:test', 'check:quick'],
})
