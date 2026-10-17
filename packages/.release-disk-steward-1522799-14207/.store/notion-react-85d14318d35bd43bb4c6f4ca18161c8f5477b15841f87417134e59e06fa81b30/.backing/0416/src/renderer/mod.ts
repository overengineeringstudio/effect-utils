export {
  createNotionRoot,
  NotionReconciler,
  walkInstances,
  blockChildren,
  projectProps,
  type Container,
  type Instance,
} from './host-config.ts'
export { OpBuffer, type Op } from './op-buffer.ts'
export {
  flattenRichText,
  INLINE_TAG,
  type Annotations,
  type InlineTag,
  type InlineComponent,
  type RichTextItem,
} from './flatten-rich-text.ts'
export { blockKey, NodeKey } from './keys.ts'
export { NotionSyncError, CacheError } from './errors.ts'
export {
  renderToNotion,
  collectOps,
  type SyncResult,
  type SyncFallbackReason,
} from './render-to-notion.ts'
export { sync, plan, type SyncPlan, type PlanStaleness } from './sync.ts'
export { pageLifecycleViolations, type PageLifecycle } from './page-lifecycle.ts'
export { SyncEvent, type SyncEventHandler } from './sync-events.ts'
export {
  extractFileUploadId,
  isUploadIdRejection,
  replaceFileUploadId,
  type OnUploadIdRejected,
  type UploadIdRejectionContext,
} from './upload-id-retry.ts'
export {
  aggregateMetrics,
  type MetricsAggregator,
  type OerRatios,
  type OpCounts,
  type SyncMetrics,
} from './sync-metrics.ts'
export {
  buildCandidateTree,
  candidateToCache,
  diff,
  hashStable,
  stableStringify,
  tallyDiff,
  tallyPageOps,
  type CandidateNode,
  type CandidateTree,
  type DiffOp,
} from './sync-diff.ts'
export {
  compareReadback,
  compareReadbackPage,
  normalizeCandidate,
  normalizeObserved,
  readbackHash,
  type NormalizedReadbackNode,
  type ObservedBlockTree,
  type ReadbackAnnotations,
  type ReadbackComparison,
  type ReadbackPageCandidate,
  type ReadbackPageComparison,
  type ReadbackRun,
} from './readback.ts'
export { observeBlockTree } from './readback-observe.ts'
export {
  adopt,
  AdoptionRefusedError,
  type AdoptionRefusal,
  type ContentDriftPolicy,
} from './adopt.ts'
export {
  UploadRegistryProvider,
  useNotionUpload,
  type UploadRecord,
  type UploadRegistry,
} from './upload-registry.ts'
export {
  NotionUrlProviderProvider,
  useNotionUrl,
  type NotionUrlProvider,
  type NotionUrlResolver,
} from './url-provider.ts'
