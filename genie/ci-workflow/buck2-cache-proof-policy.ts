import type { Buck2CachePosture } from './buck2-cache-posture.ts'

/**
 * These jobs deliberately execute no checkout-native Buck actions. Nix product
 * builds have their own nested build roots and are not native proof producers.
 * Share this declaration with generation and expected historical membership:
 * absence of an artifact is never evidence that a job was proof-disabled.
 */
export const coreProofDisabledJobIds: Readonly<Record<string, true>> = {
  'build-products': true,
  'publish-products': true,
  'publish-compiled-products': true,
  cargo: true,
  'default-ref-policy': true,
  'source-shape': true,
  'main-source-shape': true,
  'ci-measurements-report': true,
  'notify-alignment': true,
  'tested-tree': true,
  'pr-reviews-resolved': true,
  'promote-published': true,
  'pr-a-inert-buck': true,
}

/** Shared by CI declaration and historical proof membership; missing artifacts cannot reveal posture. */
export const coreCachePostures = {
  'default-ref-policy': 'reader',
  'tested-tree': 'reader',
  quality: 'trusted-writer',
  'pr-buck2-tools': 'reader',
  test: 'trusted-writer',
  'test-macos': 'trusted-writer',
  'test-playwright-utils': 'trusted-writer',
  'test-playwright-tui-react': 'trusted-writer',
  'test-megarepo-store-gc': 'reader',
  cargo: 'trusted-writer',
  weaver: 'trusted-writer',
  'source-shape': 'none',
  'test-integration-restate': 'trusted-writer',
  'build-products': 'reader',
  'pr-reviews-resolved': 'reader',
  'test-integration-notion': 'reader',
  'test-live-deploy-ci-tools': 'reader',
  'test-live-alchemy-github': 'reader',
  'deploy-storybooks': 'reader',
  'publish-products': 'reader',
  'consumer-smoke': 'reader',
  'promote-published': 'none',
  'notify-alignment': 'reader',
  'trusted-buck2-remote-cache-proof': 'writer',
  'pr-a-inert-buck': 'none',
  'pipeline-attempt-close': 'reader',
  'pipeline-traces': 'reader',
} as const satisfies Readonly<Record<string, Buck2CachePosture>>

export const coreWriterJobIds: ReadonlySet<string> = new Set(
  Object.entries(coreCachePostures)
    .filter(([, posture]) => posture === 'writer' || posture === 'trusted-writer')
    .map(([job]) => job),
)
