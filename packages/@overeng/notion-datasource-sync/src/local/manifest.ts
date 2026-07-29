import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Schema } from 'effect'

import {
  AbsolutePath,
  DataSourceId,
  type AbsolutePath as AbsolutePathType,
} from '../core/domain.ts'

/**
 * Workspace namespace version. A CLOSED literal, never a range: an incompatible
 * user surface uses a new namespace (`data/v2`, `pages/v2`, `.notion/v2`,
 * `notion.workspace.v2.json`) rather than evolving `v1` in place. Commands that
 * encounter any other version fail closed (`UnknownWorkspaceNamespace`) instead
 * of migrating.
 */
export const NAMESPACE_VERSION = 'v1'

/** File name of the workspace manifest at the workspace root. */
export const manifestFileName = `notion.workspace.${NAMESPACE_VERSION}.json`

/** Directory holding the workspace data files (the SQL API surface). */
export const dataDirectoryName = join('data', NAMESPACE_VERSION)

/** Directory holding the per-source page directories (the Markdown API surface). */
export const pagesDirectoryName = join('pages', NAMESPACE_VERSION)

/** Hidden implementation-state directory for the v1 namespace. */
export const hiddenStateDirectoryName = join('.notion', NAMESPACE_VERSION)

/**
 * Authority mode recorded in the manifest. Governs whether local edits, remote
 * state, or a converged shared view is authoritative for a workspace.
 */
export const AuthorityMode = Schema.Literal('local', 'remote', 'shared').annotate({
  identifier: 'NotionDatasourceSync.AuthorityMode',
})
export type AuthorityMode = typeof AuthorityMode.Type

/** One tracked data source entry in the workspace manifest. */
export const WorkspaceManifestDataSourceV1 = Schema.Struct({
  /** Stable workspace-local name for the source; doubles as the data-file/page-dir stem. */
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
  data_source_id: DataSourceId,
  database_id: Schema.Trimmed.check(Schema.isNonEmpty()),
  /** Workspace-relative path to the source's SQLite data file, e.g. `data/v1/<name>.sqlite`. */
  data_file: Schema.Trimmed.check(Schema.isNonEmpty()),
  /** Workspace-relative path to the source's page directory, e.g. `pages/v1/<name>`. */
  pages_dir: Schema.Trimmed.check(Schema.isNonEmpty()),
}).annotate({ identifier: 'NotionDatasourceSync.WorkspaceManifestDataSourceV1' })
export type WorkspaceManifestDataSourceV1 = typeof WorkspaceManifestDataSourceV1.Type

/**
 * Optional linked view. Linked views are not tracked sources: they own no file,
 * directory, schema, or remote write, and exist only as read-only projection
 * contexts over a tracked `data_source_id`.
 */
export const WorkspaceManifestLinkedViewV1 = Schema.Struct({
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
  view_id: Schema.Trimmed.check(Schema.isNonEmpty()),
  data_source_id: DataSourceId,
  mode: Schema.Literal('projection'),
}).annotate({ identifier: 'NotionDatasourceSync.WorkspaceManifestLinkedViewV1' })
export type WorkspaceManifestLinkedViewV1 = typeof WorkspaceManifestLinkedViewV1.Type

/**
 * The v1 workspace manifest. Source of truth for which sources a workspace
 * tracks, where their durable artifacts live, and the workspace authority mode.
 *
 * `namespace_version` is a CLOSED literal (`v1`). Decoding a manifest whose
 * version is anything else fails, and callers must translate that failure into
 * an `UnknownWorkspaceNamespace` fail-closed guard rather than migrating.
 */
export const WorkspaceManifestV1 = Schema.Struct({
  namespace_version: Schema.Literal(NAMESPACE_VERSION),
  authority_mode: AuthorityMode,
  data_sources: Schema.Array(WorkspaceManifestDataSourceV1),
  linked_views: Schema.optional(Schema.Array(WorkspaceManifestLinkedViewV1)),
}).annotate({ identifier: 'NotionDatasourceSync.WorkspaceManifestV1' })
export type WorkspaceManifestV1 = typeof WorkspaceManifestV1.Type

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}) => Schema.decodeUnknownSync(schema)(value)

/** Absolute path to the workspace manifest file. */
export const manifestPath = (workspaceRoot: AbsolutePathType): string =>
  join(workspaceRoot, manifestFileName)

/** Absolute path to a source's SQLite data file (`<root>/data/v1/<name>.sqlite`). */
export const dataFilePath = ({
  workspaceRoot,
  name,
}: {
  readonly workspaceRoot: AbsolutePathType
  readonly name: string
}): string => join(workspaceRoot, dataDirectoryName, `${name}.sqlite`)

/** Absolute path to a source's page directory (`<root>/pages/v1/<name>`). */
export const pagesDirPath = ({
  workspaceRoot,
  name,
}: {
  readonly workspaceRoot: AbsolutePathType
  readonly name: string
}): string => join(workspaceRoot, pagesDirectoryName, name)

/** Absolute path to the hidden control-plane state file (`<root>/.notion/v1/state.sqlite`). */
export const stateSqlitePath = (workspaceRoot: AbsolutePathType): string =>
  join(workspaceRoot, hiddenStateDirectoryName, 'state.sqlite')

/** Absolute path to the hidden content-addressed object store (`<root>/.notion/v1/objects`). */
export const objectsDir = (workspaceRoot: AbsolutePathType): string =>
  join(workspaceRoot, hiddenStateDirectoryName, 'objects')

/** Workspace-relative data-file path for a source name, as stored in the manifest. */
export const dataFileRelativePath = (name: string): string => `${dataDirectoryName}/${name}.sqlite`

/** Workspace-relative page-directory path for a source name, as stored in the manifest. */
export const pagesDirRelativePath = (name: string): string => `${pagesDirectoryName}/${name}`

const writeJsonFileAtomic = async ({
  path,
  value,
}: {
  readonly path: string
  readonly value: unknown
}): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

/** Atomically writes a decoded `WorkspaceManifestV1` to the workspace root. */
export const writeWorkspaceManifest = async ({
  workspaceRoot,
  manifest,
}: {
  readonly workspaceRoot: AbsolutePathType
  readonly manifest: WorkspaceManifestV1
}): Promise<void> => {
  const encoded = decode({ schema: WorkspaceManifestV1, value: manifest })
  await writeJsonFileAtomic({ path: manifestPath(workspaceRoot), value: encoded })
}

/**
 * Synchronous variant of {@link writeWorkspaceManifest}, for the synchronous
 * `parseCliContext` establish path.
 */
export const writeWorkspaceManifestSync = ({
  workspaceRoot,
  manifest,
}: {
  readonly workspaceRoot: AbsolutePathType
  readonly manifest: WorkspaceManifestV1
}): void => {
  const encoded = decode({ schema: WorkspaceManifestV1, value: manifest })
  const path = manifestPath(workspaceRoot)
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(encoded, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}

/** Versioned namespace directory matcher: `v0`, `v2`, `v3`, ... (any non-`v1`). */
const versionedNamespaceDir = /^v\d+$/

/** Versioned manifest file matcher, capturing the version segment. */
const versionedManifestFile = /^notion\.workspace\.(v\d+)\.json$/

const readDirEntries = (path: string): ReadonlyArray<{ name: string; isDirectory: boolean }> => {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  } catch {
    // Missing dir (ENOENT) or unreadable: nothing to flag here.
    return []
  }
}

/**
 * Detects sibling namespace artifacts that, alongside a `v1` workspace, make the
 * workspace ambiguous and must fail closed. Generalized beyond `v2`: any
 * `data/v*`, `pages/v*`, `.notion/v*` directory or `notion.workspace.v*.json`
 * file whose version segment is not `v1` is offending. Returns the offending
 * workspace-relative paths (sorted) so the caller can list them.
 */
const offendingSiblingNamespaceArtifacts = (
  workspaceRoot: AbsolutePathType,
): ReadonlyArray<string> => {
  const offending: string[] = []

  for (const parent of ['data', 'pages', '.notion']) {
    for (const entry of readDirEntries(join(workspaceRoot, parent))) {
      if (
        entry.isDirectory === true &&
        versionedNamespaceDir.test(entry.name) === true &&
        entry.name !== NAMESPACE_VERSION
      ) {
        offending.push(`${parent}/${entry.name}`)
      }
    }
  }

  for (const entry of readDirEntries(workspaceRoot)) {
    const match = versionedManifestFile.exec(entry.name)
    if (entry.isDirectory === false && match !== null && match[1] !== NAMESPACE_VERSION) {
      offending.push(entry.name)
    }
  }

  return offending.toSorted()
}

/**
 * Outcome of attempting to load a workspace manifest. A tagged union so callers
 * (e.g. `parseCliContext`) can fail closed with the right guard or guidance.
 */
export type LoadWorkspaceManifestResult =
  | { readonly _tag: 'tracked'; readonly manifest: WorkspaceManifestV1 }
  | { readonly _tag: 'untracked'; readonly manifestPath: string }
  | {
      readonly _tag: 'unknown-namespace'
      readonly manifestPath: string
      readonly reason: string
    }
  | {
      readonly _tag: 'mixed-namespace'
      readonly offendingPaths: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'invalid-linked-view'
      readonly manifestPath: string
      readonly reason: string
      /** Linked-view names whose `data_source_id` references an untracked source. */
      readonly offendingViews: ReadonlyArray<string>
    }

/**
 * Validates the R08 linked-view projection contract: every
 * `linked_views[*].data_source_id` MUST reference a tracked
 * `data_sources[*].data_source_id`. Linked views are read-only projections over a
 * tracked source — they own no data file, page dir, schema, or remote-write
 * authority — so a view pointing at an unknown source is a fail-closed error, not
 * a silently-ignored entry. Returns the offending view names (sorted), empty when
 * the manifest is valid.
 */
export const offendingLinkedViews = (manifest: WorkspaceManifestV1): ReadonlyArray<string> => {
  const trackedSourceIds = new Set(manifest.data_sources.map((source) => source.data_source_id))
  return (manifest.linked_views ?? [])
    .filter((view) => trackedSourceIds.has(view.data_source_id) === false)
    .map((view) => view.name)
    .toSorted()
}

/**
 * Loads and validates the workspace manifest, failing closed on anything other
 * than a clean `v1` workspace.
 *
 * - Absent manifest -> `untracked` (caller renders tracking guidance).
 * - Sibling non-`v1` namespace artifact present -> `mixed-namespace` (checked
 *   first; a mixed workspace is ambiguous even if a `v1` manifest exists).
 * - Decode failure or `namespace_version !== 'v1'` -> `unknown-namespace`
 *   (fail closed, never migrate).
 * - Otherwise -> `tracked` with the decoded manifest.
 *
 * Must run before any local edit is read as write intent.
 */
export const loadWorkspaceManifest = (
  workspaceRoot: AbsolutePathType,
): LoadWorkspaceManifestResult => {
  const offendingPaths = offendingSiblingNamespaceArtifacts(workspaceRoot)
  if (offendingPaths.length > 0) {
    return { _tag: 'mixed-namespace', offendingPaths }
  }

  const path = manifestPath(workspaceRoot)
  if (existsSync(path) === false) {
    return { _tag: 'untracked', manifestPath: path }
  }

  try {
    // Fail closed on unknown fields (`onExcessProperty: 'error'`): a manifest
    // with an unrecognized field is treated as an unknown namespace rather than
    // silently stripping the field on decode (and losing it on write-back).
    const manifest = Schema.decodeUnknownSync(WorkspaceManifestV1)(
      JSON.parse(readFileSync(path, 'utf8')),
      { onExcessProperty: 'error' },
    )
    // R08: a linked view is a read-only projection over a TRACKED source. A view
    // referencing an unknown `data_source_id` is fail-closed, not ignored — it
    // owns no writable surface, so there is no source for it to project.
    const offendingViews = offendingLinkedViews(manifest)
    if (offendingViews.length > 0) {
      return {
        _tag: 'invalid-linked-view',
        manifestPath: path,
        reason: `Linked view(s) ${offendingViews.join(', ')} reference a data_source_id not tracked in data_sources`,
        offendingViews,
      }
    }
    return { _tag: 'tracked', manifest }
  } catch (cause) {
    return {
      _tag: 'unknown-namespace',
      manifestPath: path,
      reason: `Workspace manifest is not a supported ${NAMESPACE_VERSION} namespace: ${String(cause)}`,
    }
  }
}

// Re-export `AbsolutePath` so call sites importing manifest path constructors
// can decode roots without a second domain import.
export { AbsolutePath }
