# Local Workspace Spec

Sub-system slice of [spec.md](../../spec.md). Serves [requirements](./requirements.md).

Requirement trace: FS-R01, FS-R02.

The local workspace sub-system owns local path derivation, path-claim ownership, and filesystem materialization/scanning for one sync root. Path claims, not file names, are the source of truth: a local path has at most one active owning page, and renames append path-claim events without changing row identity.

## Runtime Port

`LocalWorkspacePort` is the interface datasource sync uses to scan, claim paths, and materialize artifacts. The workspace and path policy describe how derivation and filesystem deletion behave.

```ts
type LocalWorkspacePort = {
  readonly scan: (root: AbsolutePath) => Stream<LocalArtifactObservation, LocalStorageError>
  readonly claimPath: (claim: PathClaimPlan) => Effect<PathClaimResult, LocalStorageError>
  readonly materialize: (plan: MaterializePlan) => Effect<MaterializeResult, LocalStorageError>
}

type PathPolicy = {
  readonly strategy: 'title-slug-with-row-id-suffix'
  readonly bodyExtension: '.nmd'
  readonly caseFold: boolean
  readonly unicodeNormalization: 'NFC'
}

type WorkspacePolicy = {
  readonly schemaOwnership: 'userManaged' | 'appOwned'
  readonly filesystemDelete:
    | { readonly _tag: 'candidateOnly' }
    | { readonly _tag: 'trustedRemoteTrash'; readonly requiresExplicitCommand: boolean }
  readonly pathPolicy: PathPolicy
}
```

`WorkspacePolicy` is carried on the data-source binding. `filesystemDelete` controls whether a bare local file deletion is allowed to become a remote-trash intent; the default `candidateOnly` policy never auto-applies remote trash. `schemaOwnership` governs schema convergence, which is detailed in the schema-migration sub-system.

## Path And Local Workspace Semantics

Default local path derivation is stable and row-identity preserving:

| Rule            | Decision                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| file name       | normalized title slug plus `--{page_id_short}.nmd` suffix                                                     |
| identity        | page ID suffix is mandatory even when the title is unique                                                     |
| canonical path  | root-relative POSIX-style path after Unicode NFC normalization                                                |
| case collisions | detected according to `pathPolicy.caseFold`; conflicts are stored in `path_claim`                             |
| unsafe segments | empty, dot, dot-dot, separator, control-character, and reserved segments are rejected or escaped before claim |
| symlinks        | materialization and scans must not follow symlinks outside `localRoot`                                        |

Path claims, not file names, are the source of truth. Renames append path-claim events; they do not change row identity. The `path_claim` projection enforces at most one active owner per relative path; the planner guards `PathClaimCollision` and `PathEscapesRoot` (see [spec.md](../../spec.md)) consume these observations.

Datasource-sync sidecars under `.notion-datasource-sync/pages/*.json` are owned
by the local workspace subsystem. They capture datasource path identity,
own-write suppression tokens, and last materialized body hashes for replica
planning. They are separate from NotionMD's `.notion-md/sync/{page_id}.json`
clean-base state, which remains owned by `@overeng/notion-md`.
