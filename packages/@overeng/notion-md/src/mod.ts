export {
  NmdCliError,
  NmdConflictError,
  NmdEditorAbortedError,
  NmdFileSystemError,
  NmdFrontmatterError,
  NmdGatewayError,
  NmdInvalidDocumentError,
  NmdObjectStoreError,
  NmdPartialWriteError,
  NmdPostPushGateError,
  NmdRemoteBodyLossyError,
  NmdSchemaDriftError,
  NmdTokenMissingError,
  NmdUnresolvablePageError,
} from './errors.ts'
export type { NmdError } from './errors.ts'
export { catEditorPage, editEditorPage, putEditorPage } from './editor-commands.ts'
export type {
  CatOptions,
  CatResult,
  EditOptions,
  EditorMode,
  EditResult,
  PutOptions,
  PutResult,
} from './editor-commands.ts'
export { editorBaseHash, parseTitleBody, serializeTitleBody } from './editor-surface.ts'
export type { TitleBodyDocument } from './editor-surface.ts'
export { EDITOR_EXIT_CODES, editorExitCode } from './exit-codes.ts'
export { parseNmdFile, renderNmdFile } from './frontmatter.ts'
export type { ParsedNmdFile } from './frontmatter.ts'
export { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
export { NotionMdGatewayLive } from './live.ts'
export { NotionMdGateway } from './model.ts'
export type {
  MarkdownContentUpdate,
  MarkdownUpdateCommand,
  NotionMdGatewayShape,
  PageMetadataUpdate,
  PullPageResult,
  RemoteMarkdownSnapshot,
  RemotePageSnapshot,
  RemoteParent,
  UpdateMarkdownResult,
  WritablePageCover,
  WritablePageIcon,
} from './model.ts'
export {
  isSafeRelativePath,
  NmdBaseSnapshotV2,
  NmdStateStore,
  NmdStateStoreLive,
  NmdStorageObjectV2,
  objectPath,
  objectRelativePath,
  readBaseSnapshot,
  stateRootPath,
  validateReferencedObjects,
  writeBaseSnapshot,
  writeStorageObject,
} from './state-store.ts'
export type {
  NmdBaseSnapshotV2 as NmdBaseSnapshotV2Type,
  NmdStateStoreShape,
} from './state-store.ts'
export { decideStorage } from './storage-policy.ts'
export type { StorageDecision } from './storage-policy.ts'
export { planPath, statusPath, syncPath, targetKind } from './path.ts'
export type {
  PathTargetKind,
  PlanPathOptions,
  PlanPathResult,
  StatusPathOptions,
  StatusPathResult,
  SyncPathOptions,
  SyncPathResult,
} from './path.ts'
export {
  buildFrontmatterV2,
  pullPage,
  statusPage,
  syncPage,
  syncPageReplacingBody,
} from './sync.ts'
export type {
  PullOptions,
  PullResult,
  StatusOptions,
  StatusResult,
  SyncOptions,
  SyncResult,
} from './sync.ts'
export { canonicalHash, canonicalize, semanticEqual } from './canonicalizer.ts'
export { decideReconcile, porcelainStatus } from './reconcile-core.ts'
export type { PorcelainStatus, ReconcileCompare, ReconcileDecision } from './reconcile-core.ts'
export { decideShared, reconcileShared, sharedPorcelain } from './reconcile-shared.ts'
export type { SharedOutcome } from './reconcile-shared.ts'
export { clonePage, reconcileFile, reconcileTree, statusFile, statusTree } from './reconcile.ts'
export type { CloneResult, ReconcileResult, ReconcileStatus } from './reconcile.ts'
export { NOTION_MD_VERSION } from './version.ts'
export { pageUrl, resolveCrossRefs, validateCrossRefTargets } from './cross-refs.ts'
export type { TreeOp, TreeSyncResult } from './tree.ts'
export {
  isSingleFileTarget,
  resolveNmdTargets,
  runBatchWatch,
  statusMany,
  syncMany,
} from './batch.ts'
export type {
  BatchFailure,
  BatchItemResult,
  BatchOperation,
  BatchResult,
  BatchSuccess,
  BatchWatchOptions,
  ResolveTargetsOptions,
  ResolveTargetsResult,
  StatusManyOptions,
  SyncManyOptions,
  WatchReason,
} from './batch.ts'
export {
  materializeBody,
  NotionMdBodyConflictError,
  observeRemoteBody,
  observeRemoteEditorPage,
  readLocalBody,
  replaceRemoteBodyForced,
  replaceRemoteBodyVerified,
  settleVerifiedBodyPush,
} from './body-facade.ts'
export type {
  NotionMdBodySnapshot,
  NotionMdEditorSnapshot,
  NotionMdLocalBodySnapshot,
  NotionMdMaterializedBody,
  NotionMdSettledBodyPush,
  NotionMdVerifiedRemoteReplaceResult,
} from './body-facade.ts'
