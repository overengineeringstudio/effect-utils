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
export { blockKey } from './keys.ts'
export { NotionSyncError, CacheError } from './errors.ts'
export {
  renderToNotion,
  collectOps,
  type SyncResult,
  type SyncFallbackReason,
} from './render-to-notion.ts'
export { sync } from './sync.ts'
export { SyncEvent, type SyncEventHandler } from './sync-events.ts'
export {
  buildCandidateTree,
  candidateToCache,
  diff,
  stableStringify,
  tallyDiff,
  type CandidateNode,
  type CandidateTree,
  type DiffOp,
} from './sync-diff.ts'
export {
  UploadRegistryProvider,
  useNotionUpload,
  type UploadRecord,
  type UploadRegistry,
} from './upload-registry.ts'
