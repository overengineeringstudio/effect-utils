import { Schema } from 'effect'

import { OtelAttr, OtelAttrs, OtelSpan } from '@overeng/otel-contract'

const basename = (path: string): string =>
  path.split('/').findLast((part) => part.length > 0) ?? path

export const labelAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
  }),
)

export const repoPathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    repoPath: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.repo_path' })),
  }),
)

export const worktreePathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    worktreePath: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.worktree_path' })),
  }),
)

export const gitUrlAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    url: Schema.String.pipe(OtelAttr.key({ key: 'git.url' })),
    bare: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'git.bare' }))),
  }),
)

export const gitBranchAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    branch: Schema.String.pipe(OtelAttr.key({ key: 'git.branch' })),
  }),
)

export const gitCommitAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    commit: Schema.String.pipe(OtelAttr.key({ key: 'git.commit' })),
  }),
)

export const workspaceAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    workspaceRoot: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.workspace_root' })),
  }),
)

export const storeLiveSetAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    hasCurrentWorkspace: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'megarepo.store.has_current_workspace' }),
    ),
    pruneStaleRegistry: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'megarepo.store.prune_stale_registry' }),
    ),
    refreshCurrentWorkspace: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'megarepo.store.refresh_current_workspace' }),
    ),
  }),
)

export const nixFlakeMetadataAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    owner: Schema.String.pipe(OtelAttr.key({ key: 'nix.flake.owner' })),
    repo: Schema.String.pipe(OtelAttr.key({ key: 'nix.flake.repo' })),
    rev: Schema.String.pipe(OtelAttr.key({ key: 'nix.flake.rev' })),
  }),
)

export const nixLockFileAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'nix.lock.path' })),
    type: Schema.String.pipe(OtelAttr.key({ key: 'nix.lock.type' })),
  }),
)

export const syncMemberCloneAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    bareExists: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.sync.member.bare_exists' })),
  }),
)

export const syncMemberRefAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    ref: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.ref' })),
    refType: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.ref_type' })),
    ),
  }),
)

export const syncMemberAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    name: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.name' })),
    source: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.source' })),
  }),
)

export const syncMemberActionAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    action: Schema.Literal(
      'clone',
      'already-cloned-by-sibling',
      'skip-dry-run',
      'fetch',
      'fetch-missing-commit',
      'noop',
    ).pipe(OtelAttr.key({ key: 'megarepo.sync.member.action' })),
  }),
)

type SyncMemberAction =
  | 'clone'
  | 'already-cloned-by-sibling'
  | 'skip-dry-run'
  | 'fetch'
  | 'fetch-missing-commit'
  | 'noop'

export const syncMemberResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    status: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.result_status' })),
  }),
)

export const label = (value: string) => labelAttrs.unsafeEncode({ label: value })

export const repoPath = (path: string) =>
  repoPathAttrs.unsafeEncode({ label: basename(path), repoPath: path })

export const worktreePath = (path: string) =>
  worktreePathAttrs.unsafeEncode({ label: basename(path), worktreePath: path })

export const workspaceRoot = (path: string) =>
  workspaceAttrs.unsafeEncode({ label: basename(path), workspaceRoot: path })

export const withLabelSpan = (name: string, labelValue: string) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: labelAttrs },
    attributes: { label: labelValue },
  })

export const withSyncMemberCloneSpan = ({
  name,
  bareExists,
}: {
  readonly name: string
  readonly bareExists: boolean
}) =>
  OtelSpan.unsafeWith({
    span: { name: 'megarepo/sync/member/clone-or-fetch', attributes: syncMemberCloneAttrs },
    attributes: { label: name, bareExists },
  })

export const withSyncMemberResolveRefSpan = (ref: string) =>
  OtelSpan.unsafeWith({
    span: { name: 'megarepo/sync/member/resolve-ref', attributes: syncMemberRefAttrs },
    attributes: { label: ref, ref },
  })

export const withSyncMemberCreateWorktreeSpan = ({
  ref,
  refType,
}: {
  readonly ref: string
  readonly refType: string
}) =>
  OtelSpan.unsafeWith({
    span: { name: 'megarepo/sync/member/create-worktree', attributes: syncMemberRefAttrs },
    attributes: { label: ref, ref, refType },
  })

export const withSyncMemberSpan = ({
  name,
  source,
}: {
  readonly name: string
  readonly source: string
}) =>
  OtelSpan.unsafeWith({
    span: { name: 'megarepo/sync/member', attributes: syncMemberAttrs },
    attributes: { label: name, name, source },
  })

export const annotateSyncMemberAction = (action: SyncMemberAction) =>
  OtelSpan.unsafeAnnotate({
    attributes: syncMemberActionAttrs,
    value: { action },
  })

export const annotateSyncMemberResult = (status: string) =>
  OtelSpan.unsafeAnnotate({
    attributes: syncMemberResultAttrs,
    value: { status },
  })
