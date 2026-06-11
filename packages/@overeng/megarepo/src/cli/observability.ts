import path from 'node:path'

import { Schema } from 'effect'

import { OtelAttr, OtelAttrs, OtelSpan, type OtelSpanDefinition } from '@overeng/otel-contract'

const basename = (value: string): string =>
  value.split('/').findLast((part) => part.length > 0) ?? value

export const shortRef = ({ refType, ref }: { refType: string; ref: string }): string =>
  `${refType}/${ref.length > 24 ? `${ref.slice(0, 12)}...${ref.slice(-8)}` : ref}`

export const shortPath = (value: string): string => basename(value.replace(/\/+$/, ''))

const applySpan = <S extends Schema.Schema.AnyNoContext>({
  span,
  attributes,
}: {
  span: OtelSpanDefinition<S>
  attributes: Schema.Schema.Type<S>
}) => OtelSpan.unsafeWith({ span, attributes })

export const commandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    command: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'megarepo.cli.command' })),
    output: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'megarepo.cli.output' }))),
    all: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.all' }))),
    dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.dry_run' }))),
    force: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.force' }))),
    member: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'megarepo.member' }))),
    repo: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'megarepo.repo' }))),
  }),
)

export const syncSpan = {
  name: 'megarepo/sync',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
      root: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.root' })),
      mode: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.mode' })),
      depth: Schema.Number.pipe(OtelAttr.key({ key: 'megarepo.sync.depth' })),
      dryRun: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.dry_run' })),
      all: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.all' })),
      force: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.force' })),
    }),
  ),
} as const

export const storeWorktreeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    repo: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.repo' })),
    refType: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.ref_type' })),
    ref: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.ref' })),
    worktreePath: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.worktree_path' })),
    ),
    bareRepoPath: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.bare_repo_path' })),
    ),
    broken: Schema.optional(
      Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.store.worktree_broken' })),
    ),
  }),
)

export const storeGcAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    policy: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.gc.policy' })),
    dryRun: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.dry_run' })),
    force: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.force' })),
    all: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.all' })),
  }),
)

export const storeGcResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    rootSetWorkspaceCount: Schema.Number.pipe(
      OtelAttr.key({ key: 'megarepo.store.gc.root_set_workspace_count' }),
    ),
    repoTotal: Schema.Number.pipe(OtelAttr.key({ key: 'megarepo.store.gc.repo_total' })),
    worktreeDiscovered: Schema.Number.pipe(
      OtelAttr.key({ key: 'megarepo.store.gc.worktree_discovered' }),
    ),
    resultTotal: Schema.Number.pipe(OtelAttr.key({ key: 'megarepo.store.gc.result_total' })),
    resultRemoved: Schema.Number.pipe(OtelAttr.key({ key: 'megarepo.store.gc.result_removed' })),
    resultSkippedInUse: Schema.Number.pipe(
      OtelAttr.key({ key: 'megarepo.store.gc.result_skipped_in_use' }),
    ),
    resultSkippedDirty: Schema.Number.pipe(
      OtelAttr.key({ key: 'megarepo.store.gc.result_skipped_dirty' }),
    ),
    candidateCommits: Schema.Number.pipe(
      OtelAttr.key({ key: 'megarepo.store.gc.candidate_commits' }),
    ),
    candidateNamedRefs: Schema.Number.pipe(
      OtelAttr.key({ key: 'megarepo.store.gc.candidate_named_refs' }),
    ),
  }),
)

export const storeGitWorktreeListFailureAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    failed: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.store.git_worktree_list_failed' })),
  }),
)

export const storeSourceAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    source: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.source' })),
    ref: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.ref' }))),
    base: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.base_ref' }))),
    commit: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.commit' }))),
    porcelain: Schema.optional(
      Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.cli.porcelain' })),
    ),
  }),
)

export const withCommandSpan = ({
  name,
  command,
  label = command,
  output,
  all,
  dryRun,
  force,
  member,
  repo,
  root = false,
}: {
  name: string
  command: string
  label?: string
  output?: string
  all?: boolean
  dryRun?: boolean
  force?: boolean
  member?: string
  repo?: string
  root?: boolean
}) =>
  applySpan({
    span: {
      name,
      attributes: commandAttrs,
      ...(root === true ? { root: true } : {}),
    },
    attributes: {
      label,
      command,
      ...(output === undefined ? {} : { output }),
      ...(all === undefined ? {} : { all }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(force === undefined ? {} : { force }),
      ...(member === undefined ? {} : { member }),
      ...(repo === undefined ? {} : { repo }),
    },
  })

export const withSyncSpan = ({
  megarepoRoot,
  mode,
  depth,
  dryRun,
  all,
  force,
}: {
  megarepoRoot: string
  mode: string
  depth: number
  dryRun: boolean
  all: boolean
  force: boolean
}) =>
  applySpan({
    span: syncSpan,
    attributes: {
      label: shortPath(megarepoRoot),
      root: megarepoRoot,
      mode,
      depth,
      dryRun,
      all,
      force,
    },
  })

export const annotateCommand = ({
  label,
  command,
  output,
  all,
  dryRun,
  force,
  member,
  repo,
}: {
  label: string
  command: string
  output?: string
  all?: boolean
  dryRun?: boolean
  force?: boolean
  member?: string
  repo?: string
}) =>
  OtelSpan.unsafeAnnotate({
    attributes: commandAttrs,
    value: {
      label,
      command,
      ...(output === undefined ? {} : { output }),
      ...(all === undefined ? {} : { all }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(force === undefined ? {} : { force }),
      ...(member === undefined ? {} : { member }),
      ...(repo === undefined ? {} : { repo }),
    },
  })

export const annotateStoreGcResult = (
  value: Schema.Schema.Type<typeof storeGcResultAttrs.schema>,
) => OtelSpan.unsafeAnnotate({ attributes: storeGcResultAttrs, value })

export const annotateStoreGitWorktreeListFailure = (failed: boolean) =>
  OtelSpan.unsafeAnnotate({
    attributes: storeGitWorktreeListFailureAttrs,
    value: { failed },
  })

export const withStoreWorktreeSpan = ({
  name,
  repo,
  refType,
  ref,
  worktreePath,
  bareRepoPath,
  broken,
}: {
  name: string
  repo: string
  refType: string
  ref: string
  worktreePath?: string
  bareRepoPath?: string
  broken?: boolean
}) =>
  applySpan({
    span: { name, attributes: storeWorktreeAttrs },
    attributes: {
      label: `${shortPath(repo)} ${shortRef({ refType, ref })}`,
      repo,
      refType,
      ref,
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...(bareRepoPath === undefined ? {} : { bareRepoPath }),
      ...(broken === undefined ? {} : { broken }),
    },
  })

export const withStoreGcSpan = ({
  policy,
  dryRun,
  force,
  all,
}: {
  policy: string
  dryRun: boolean
  force: boolean
  all: boolean
}) =>
  applySpan({
    span: { name: 'megarepo/store/gc', attributes: storeGcAttrs, root: true },
    attributes: {
      label: 'gc',
      policy,
      dryRun,
      force,
      all,
    },
  })

export const withStoreSourceSpan = ({
  name,
  source,
  ref,
  base,
  commit,
  porcelain,
}: {
  name: string
  source: string
  ref?: string
  base?: string
  commit?: string
  porcelain?: boolean
}) =>
  applySpan({
    span: { name, attributes: storeSourceAttrs },
    attributes: {
      label: shortPath(source),
      source,
      ...(ref === undefined ? {} : { ref }),
      ...(base === undefined ? {} : { base }),
      ...(commit === undefined ? {} : { commit }),
      ...(porcelain === undefined ? {} : { porcelain }),
    },
  })

export const storeWorktree = ({
  repo,
  refType,
  ref,
  worktreePath,
  bareRepoPath,
  broken,
}: {
  repo: string
  refType: string
  ref: string
  worktreePath?: string
  bareRepoPath?: string
  broken?: boolean
}) =>
  storeWorktreeAttrs.unsafeEncode({
    label: `${shortPath(repo)} ${shortRef({ refType, ref })}`,
    repo,
    refType,
    ref,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(bareRepoPath === undefined ? {} : { bareRepoPath }),
    ...(broken === undefined ? {} : { broken }),
  })

export const storeSource = ({
  source,
  ref,
  base,
  commit,
  porcelain,
}: {
  source: string
  ref?: string
  base?: string
  commit?: string
  porcelain?: boolean
}) =>
  storeSourceAttrs.unsafeEncode({
    label: shortPath(source),
    source,
    ...(ref === undefined ? {} : { ref }),
    ...(base === undefined ? {} : { base }),
    ...(commit === undefined ? {} : { commit }),
    ...(porcelain === undefined ? {} : { porcelain }),
  })

export const pathLabel = (value: string): string => shortPath(path.normalize(value))
