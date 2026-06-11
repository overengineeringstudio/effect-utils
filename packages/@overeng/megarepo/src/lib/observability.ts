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

export const nixLockPathTypeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'path' })),
    type: Schema.String.pipe(OtelAttr.key({ key: 'type' })),
  }),
)

export const nixLockPathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'path' })),
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

export const withRepoPathSpan = (name: string, path: string) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: repoPathAttrs },
    attributes: { label: basename(path), repoPath: path },
  })

export const withWorktreePathSpan = ({
  name,
  worktreePath,
  label = basename(worktreePath),
}: {
  readonly name: string
  readonly worktreePath: string
  readonly label?: string
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: worktreePathAttrs },
    attributes: { label, worktreePath },
  })

export const withGitUrlSpan = ({
  name,
  label,
  url,
  bare,
}: {
  readonly name: string
  readonly label: string
  readonly url: string
  readonly bare?: boolean
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: gitUrlAttrs },
    attributes: {
      label,
      url,
      ...(bare === undefined ? {} : { bare }),
    },
  })

export const withGitBranchSpan = ({
  name,
  branch,
}: {
  readonly name: string
  readonly branch: string
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: gitBranchAttrs },
    attributes: { label: branch, branch },
  })

export const withGitCommitSpan = ({
  name,
  label,
  commit,
}: {
  readonly name: string
  readonly label: string
  readonly commit: string
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: gitCommitAttrs },
    attributes: { label, commit },
  })

export const withWorkspaceSpan = ({
  name,
  workspaceRoot,
  label = basename(workspaceRoot),
}: {
  readonly name: string
  readonly workspaceRoot: string
  readonly label?: string
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: workspaceAttrs },
    attributes: { label, workspaceRoot },
  })

export const withStoreLiveSetSpan = ({
  name,
  hasCurrentWorkspace,
  pruneStaleRegistry,
  refreshCurrentWorkspace,
}: {
  readonly name: string
  readonly hasCurrentWorkspace: boolean
  readonly pruneStaleRegistry: boolean
  readonly refreshCurrentWorkspace: boolean
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: storeLiveSetAttrs },
    attributes: {
      label: 'store',
      hasCurrentWorkspace,
      pruneStaleRegistry,
      refreshCurrentWorkspace,
    },
  })

export const withNixFlakeMetadataSpan = ({
  owner,
  repo,
  rev,
}: {
  readonly owner: string
  readonly repo: string
  readonly rev: string
}) =>
  OtelSpan.unsafeWith({
    span: { name: 'fetchNixFlakeMetadata', attributes: nixFlakeMetadataAttrs },
    attributes: {
      label: `${owner}/${repo}@${rev.slice(0, 8)}`,
      owner,
      repo,
      rev,
    },
  })

export const withNixLockFileSpan = ({
  lockPath,
  lockType,
}: {
  readonly lockPath: string
  readonly lockType: string
}) =>
  OtelSpan.unsafeWith({
    span: { name: 'megarepo/nix-lock/file', attributes: nixLockFileAttrs },
    attributes: {
      label: basename(lockPath),
      path: lockPath,
      type: lockType,
    },
  })

export const withNixLockPathTypeSpan = ({
  name,
  path,
  type,
}: {
  readonly name: string
  readonly path: string
  readonly type: string
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: nixLockPathTypeAttrs },
    attributes: { label: path, path, type },
  })

export const withNixLockPathSpan = ({
  name,
  path,
}: {
  readonly name: string
  readonly path: string
}) =>
  OtelSpan.unsafeWith({
    span: { name, attributes: nixLockPathAttrs },
    attributes: { label: path, path },
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
