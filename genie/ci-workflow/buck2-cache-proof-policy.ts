import type { Buck2CachePosture } from './buck2-cache-posture.ts'

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
  'source-shape': 'reader',
  'test-integration-restate': 'trusted-writer',
  'build-products': 'reader',
  'pr-reviews-resolved': 'reader',
  'test-integration-notion': 'reader',
  'test-live-deploy-ci-tools': 'reader',
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
