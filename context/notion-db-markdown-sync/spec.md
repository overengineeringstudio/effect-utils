# Notion DB Markdown Sync Spec

This document specifies the local Markdown and SQLite user surfaces for Notion
data-source pages. It builds on [requirements.md](./requirements.md), plus the
package contracts in
[`packages/@overeng/notion-datasource-sync/docs/vrs/requirements.md`](../../packages/@overeng/notion-datasource-sync/docs/vrs/requirements.md)
and [`packages/@overeng/notion-md/docs/vrs/spec.md`](../../packages/@overeng/notion-md/docs/vrs/spec.md).

## Status

Draft. The current recommendation is to design for the smallest possible
end-user surface: one SQLite data file for SQL workflows and one `.nmd` page
file per Notion page for editor workflows. Hidden implementation state may
exist, but it is not user API.

## Scope

This spec defines:

- the intended end-user local surfaces,
- the separation between user surfaces and hidden implementation state,
- the proposed local file shape for page files,
- how Markdown and SQLite edits compose through one sync-control model.

It does not define:

- a replacement sync-control store,
- a NotionMD tree feature,
- a hosted webhook receiver,
- a production implementation plan.

## Architecture

```text
Notion data source
       |
       v
@overeng/notion-datasource-sync
  hidden sync-control state
       |
       +-- data/v1/*.sqlite  # SQL user surface
       |
       +-- pages/v1/**/*.nmd # Markdown user surface
```

Requirement trace: R01-R05.

The product surface should feel like editing local files. Hidden implementation
state owns sync-control authority and may use SQLite internally, but users
interact with public SQLite data files and Markdown page files, not with private
tables, base hashes, outbox state, leases, or sidecars.

## Filesystem Shape

Requirement trace: R01-R08.

Workspace shape is intentionally version-namespaced from the first supported
layout. A single-source workspace still uses the same shape with one source
entry:

```text
workspace/
  notion.workspace.v1.json
  data/
    v1/
      tasks.sqlite
  pages/
    v1/
      tasks/
        launch-checklist--<page-id-short>.nmd
  .notion/
    v1/
      state.sqlite
      objects/
```

Multi-source workspace:

```text
workspace/
  notion.workspace.v1.json
  data/
    v1/
      tasks.sqlite
      customers.sqlite
  pages/
    v1/
      tasks/
        launch-checklist--<page-id-short>.nmd
      customers/
        acme--<page-id-short>.nmd
  .notion/
    v1/
      state.sqlite
      objects/
```

Only data files and `pages/**/*.nmd` are intended user surfaces.
`.notion/v1/`, private control-plane databases, object stores, leases, own-write
markers, and page-file sidecars are implementation state. They may be
inspectable for debugging, but they are not a stable read/write API.

`data/v1/<source>.sqlite` is the SQL API for the v1 workspace namespace, and
`pages/v1/<source>/*.nmd` is the Markdown API. An incompatible user
surface uses a new namespace such as `data/v2`, `pages/v2`,
`notion.workspace.v2.json`, and `.notion/v2`. Commands that encounter an
unknown or mixed namespace version fail closed before reading local edits as
write intent. They may provide explicit tracking guidance, but they do not
silently migrate, rewrite, or reinterpret local artifacts.

Page identity is the Notion page ID, never the title or path. Paths are claims
and may change without changing page identity.

Each tracked data source owns exactly one data file and one page directory.
Linked views are not tracked sources. They are optional read-only
presentation/query contexts over a tracked `data_source_id`.

## Page File

Requirement trace: R03, R09-R14.

A page file is a real NotionMD `.nmd` file, not a second friendlier Markdown
dialect. It uses strict JSON frontmatter under `notion_md`, with datasource page
properties represented through the same property model as standalone NotionMD:

```md
---
{
  'notion_md':
    {
      'version': 2,
      'api_version': '2026-03-11',
      'object': 'page',
      'source': 'shared',
      'page_id': '00000000-0000-4000-8000-000000000001',
      'parent': { '_tag': 'data_source', 'id': '00000000-0000-4000-8000-000000000002' },
      'page':
        {
          'title': 'Launch checklist',
          'icon': null,
          'cover': null,
          'in_trash': false,
          'is_locked': false,
        },
      'properties':
        {
          'Status': { '_tag': 'select', 'value': 'In progress' },
          'Due':
            { '_tag': 'date', 'value': { 'start': '2026-06-14', 'end': null, 'time_zone': null } },
          'Done': { '_tag': 'checkbox', 'value': false },
        },
    },
}
---

# Launch checklist

Body content here.
```

The user-facing file should not expose base hashes, schema hashes, outbox
state, leases, or sync-control payloads. The visible `.nmd` envelope stays
valid under the standalone NotionMD body and frontmatter contract.

The file may carry compact, non-authoritative property descriptors when they
improve portability and diagnostics:

```json
{
  "notion_md": {
    "property_descriptors": {
      "Status": {
        "property_id": "prop_abc",
        "property_name": "Status",
        "property_type": "select",
        "data_source_id": "00000000-0000-4000-8000-000000000002",
        "config_hash": "sha256:..."
      }
    }
  }
}
```

Descriptors prove only what the file claims to edit. They do not prove that the
write is still safe. Current schema freshness, base values, local convergence,
relation availability, outbox state, leases, and settlement evidence remain live
or hidden workspace proof.

Datasource page files should remain standalone syncable through the NotionMD CLI
for page-scoped operations. Datasource-sync may require hidden state for
workspace-level guarantees such as property-ID disambiguation, local
surface convergence, relation safety, outbox, conflicts, and watch behavior, but
it must not make the visible `.nmd` file invalid or proprietary. If a NotionMD
operation needs datasource-wide context it cannot prove, it must fail closed
with a clear explanation rather than bypassing datasource-sync guards.

Property mutation is guarded by capability proof rather than by CLI entrypoint
or by the standalone-page versus datasource-page distinction. Standalone
NotionMD does not have to categorically reject datasource-scoped property edits,
but it may apply them only when it can prove the same invariants that
datasource-sync would require:

- the proof identifies whether the field is page-scoped or datasource-scoped,
- datasource-scoped writes are bound to stable property IDs from `.nmd`
  descriptors, workspace state, or fresh live schema evidence,
- a fresh remote schema proves that the stable property ID still exists and
  that display-name collisions do not make the user-facing field ambiguous,
- the canonical value fits the current property type and configuration,
- the property write class is writable,
- complete current property values are known for paginated/list-like surfaces
  before the write relies on a base,
- relation writes prove that all target pages are known and available,
- local data-file facts do not disagree with the `.nmd` desired value,
- shared-mode writes have durable outbox and read-after-write settlement
  context.

If any proof is missing, the mutation fails closed with a specific guard. Example
guards include `RemoteSchemaRequired`, `PropertyIdentityAmbiguous`,
`RelationTargetsUnavailable`, `LocalSurfaceDisagreement`, and
`StaleRemoteSchema`.

Unsupported, computed, paginated, lossy, or ambiguous values must not look
writable. They should be omitted, rendered read-only, or surfaced through the
SQLite/status surfaces with explicit guard messages.

### Property Write Core

Requirement trace: R09-R14.

Property write planning is a shared semantic capability. The mutation core
depends on canonical Notion property schemas and codecs from
`@overeng/notion-effect-schema`; it does not duplicate property value unions,
write payload encoders, property identity brands, or write-class taxonomy.

```text
@overeng/notion-effect-schema
  canonical property values
  property descriptors
  property write payload codecs
  property write-class taxonomy
        |
        v
PropertyWriteCore
  validates PropertyWriteProof
  emits allow/block guard decisions
        |
        +-- StandaloneLiveProofProvider
        |     re-read parent data source schema
        |     re-read current page/property values
        |     prove property identity, config, write class, and bases
        |
        +-- DatasourceWorkspaceProofProvider
              read hidden .notion control plane
              converge data/v1/*.sqlite and pages/v1/**/*.nmd
              prove relation availability, outbox, conflicts, settlement
```

`@overeng/notion-effect-schema` owns schema/value/codec/classification facts.
The proof providers own evidence acquisition. Datasource-sync owns workspace
convergence, outbox, conflicts, leases, and settlement. NotionMD owns `.nmd`
parsing, body sync, and standalone live proof acquisition. This keeps property
semantics shared without turning the schema package into a sync engine.

Mode consequences:

| Mode     | Datasource property mutation policy                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------ |
| `remote` | normal sync rejects local mutation as drift because Notion is authoritative                            |
| `local`  | standalone mutation may proceed with live schema/page proof and `--dry-run` support                    |
| `shared` | mutation requires datasource workspace proof for convergence, bases, outbox, conflicts, and settlement |

## SQLite User Surface

Requirement trace: R01-R08, R15.

The data file is the precise tabular/scriptable surface for one tracked data
source. It contains only public tables/views. Private sync-control tables do not
live in this file; event log, outbox, leases, base hashes, checkpoints, object
state, and repair metadata live under hidden `.notion/v1/` implementation state.

| Surface       | Intended access | Role                                               |
| ------------- | --------------- | -------------------------------------------------- |
| `pages`       | writable        | supported page/property/lifecycle intents          |
| `changes`     | read-only       | accepted local intent lifecycle                    |
| `conflicts`   | read-only       | conflict inspection and explicit resolution inputs |
| `sync_status` | read-only       | aggregate health and pending work                  |
| `schema`      | read-only       | observed schema and property mapping               |
| `debug_*`     | read-only       | diagnostics, not product workflow                  |

The public SQL surface is clean-break v1. It exposes `pages`, not `rows`, and
must not create a public `rows` table/view. If an
implementation uses internal row terminology for planner code, that terminology
must not leak into durable public SQLite schema, workspace paths, CLI help, or
user docs.

## Local Edit Model

Requirement trace: R06-R08, R11-R15.

The workspace has one authority mode, using the same vocabulary as NotionMD:
`local`, `remote`, or `shared`.

| Mode     | Authority                       | User surface consequence                                        | Hidden `.notion/v1/` requirement                                                 |
| -------- | ------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `remote` | Notion                          | data files and `pages/v1/**/*.nmd` are generated mirror outputs | Optional cache/checkpoint only; deleting it affects performance, not correctness |
| `local`  | Local workspace                 | local files/tables are desired state and may overwrite Notion   | Minimal state only for create idempotency/retry safety                           |
| `shared` | Both local workspace and Notion | bidirectional authoring with conflict refusal/resolution        | Required durable control plane: bases, outbox, conflicts, leases, checkpoints    |

The mode is workspace-level. Individual tracked data sources, data files,
and `pages/v1/**/*.nmd` must not declare independent conflicting modes. If a project
needs different authority contracts for different data sources, it should use
separate workspaces rather than mixing authority semantics in one workspace.
The mode is established in `notion.workspace.v1.json` when the workspace is
tracked. Established `sync`, `status`, `export`, `doctor`, and watch commands
read that persisted mode and do not accept per-run mode overrides.

In `shared` mode, both user surfaces feed the same planner:

```text
read data/v1/*.sqlite pages AND read pages/v1/**/*.nmd
  -> decode and validate both local surfaces
  -> converge local facts by page_id + property_id/body/lifecycle
  -> coalesce identical desired states
  -> raise local conflicts for divergent local desired states
  -> append one unambiguous typed local intent per surface
  -> plan against known base and fresh remote observation
  -> enqueue guarded outbox commands
  -> verify by read-after-write before settlement
```

The entry surface is not authority. The consequences of the edit are defined by
the accepted local intent and planner result.

Local convergence happens before remote planning. Data files and
`pages/v1/**/*.nmd` must not compete as parallel local truths. If both local surfaces
edit the same page/property/body/lifecycle surface to the same desired state,
sync coalesces them. If they edit it differently, sync raises a local conflict
and blocks remote mutation until the local disagreement is resolved.

In `remote` and `local` mirror modes, concurrent-edit detection is deliberately
not promised. Like standalone NotionMD single-source files, the declared source
wins when local and remote differ. Users opt into `shared` when they want
base-anchored bidirectional safety.

`remote` mode treats data files and `pages/v1/**/*.nmd` as generated mirrors. Local
edits are local drift; `status` and `sync --dry-run` report that drift, and
`sync` may overwrite it because Notion is the declared authority.

`local` mode treats the workspace as desired state. Remote drift is overwritten
when the local surface can be decoded into a supported desired state. Unbound
local page creation may require minimal hidden idempotency state so a retried
create does not duplicate remote pages.

Watch mode is available in each authority mode, but its guarantee follows the
mode:

| Mode             | Watch meaning                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `remote --watch` | observe Notion and regenerate local mirror surfaces; local edits remain drift and may be overwritten                                 |
| `local --watch`  | observe local filesystem/SQLite changes and apply supported desired state to Notion; remote drift conflict detection is not promised |
| `shared --watch` | durable bidirectional live sync with local and remote intake, outbox, leases, conflicts, and repair                                  |

Only `shared --watch` implies the full `.notion/v1/` control plane. Single-source
watch modes may use lightweight cache/checkpoint state, but their output must
make the reduced guarantee explicit.

## Guard Rails

Requirement trace: R06, R11, R13-R15.

The visible surface must be hard to misuse:

- deleting a page file creates a local delete candidate only; remote archive
  requires an explicit archive command or explicit archive field,
- property rename collisions block instead of guessing,
- unsupported property edits block before becoming accepted local intent,
- stale bases create conflicts instead of overwrites,
- generated/computed fields are read-only or omitted from Markdown,
- dry-run performs no Notion, SQLite, file, sidecar, outbox, or settlement
  writes,
- materialization never overwrites dirty local Markdown without first preserving
  it as accepted intent or conflict material.

## Conflict Visibility

Requirement trace: R06, R13-R15.

Canonical conflicts are visible through data files and CLI/status output.
Generated page-adjacent conflict files are not part of the default datasource
workspace surface because they add visible artifacts that can be mistaken for
editable source files.

```text
data/v1/<source>.sqlite
  conflicts      # local-surface and remote conflicts

notion status
notion conflicts list
```

Standalone NotionMD may still use body-specific roughdraft/conflict artifacts
when the conflict is intrinsically a page-body merge artifact. Datasource
property/lifecycle/local-surface conflicts should not create `pages/*.conflict.*`
files by default.

## Linked Views

Requirement trace: R08.

Linked database views and Notion views are presentation/query contexts over a
data source. They do not create additional writable local page directories or
data files.

```json
{
  "data_sources": [
    {
      "name": "tasks",
      "data_source_id": "...",
      "database_id": "...",
      "data_file": "data/v1/tasks.sqlite",
      "pages_dir": "pages/v1/tasks"
    }
  ],
  "linked_views": [
    {
      "name": "active_tasks",
      "view_id": "...",
      "data_source_id": "...",
      "mode": "projection"
    }
  ]
}
```

Rules:

- `linked_views[*].data_source_id` must reference a tracked data source,
- linked views do not own schema, pages, deletion, remote writes, or absence
  evidence,
- page files are materialized once under the owning data source directory,
- relation values point to canonical page/data-source identity, not linked-view
  paths,
- linked views produce no visible files by default,
- read-only `views/` projections may be generated only when explicitly
  requested and must be clearly non-authoritative.

## Relations

Requirement trace: R08, R11, R14.

Relation properties use canonical page identity, not local paths. A relation
value may include read-only display hints, but the authoritative value is the
target page ID plus the owning tracked data source.

```json
{
  "_tag": "relation",
  "value": [
    {
      "page_id": "00000000-0000-4000-8000-000000000001",
      "data_source": "customers",
      "title": "ACME",
      "path": "pages/v1/customers/acme--000001.nmd"
    }
  ]
}
```

`title` and `path` are hints. Renaming or moving a page file must not change
relation identity. Adding a relation target is accepted only when the target
page identity is known and accessible under a tracked source. Explicit lookup
flows for untracked targets are outside the v1 surface.

## Resolved Design Points

The following constraints are fixed by [requirements.md](./requirements.md) and
the accepted decision records:

- data files and `pages/**/*.nmd` are the intended user read/write surfaces.
- Durable workspace artifacts are version-namespaced (`notion.workspace.v1.json`,
  `data/v1`, `pages/v1`, `.notion/v1`) and unknown/mixed versions fail closed
  instead of being reinterpreted by established commands.
- The public SQL v1 surface is `pages`; `rows` is not a public table/view,
  alias, or command path.
- `.nmd` files may carry compact property descriptors, but freshness,
  convergence, base, relation, outbox, and settlement proof comes from live or
  workspace context.
- `.notion/v1/` is correctness-critical for `shared` mode and optional/lightweight
  for mirror modes except where idempotency or retry safety requires state.
- Local convergence across data files and `pages/**/*.nmd` is mandatory
  before shared-mode remote write planning.
- Datasource conflicts are canonical in SQLite/status surfaces, not generated
  page-adjacent conflict files.
- `remote` and `local` use single-source mirror semantics; `shared` provides
  bidirectional safety.
- Watch exists in all authority modes, but only `shared --watch` promises the
  full durable bidirectional control plane.
- Linked views are read-only projections and do not create additional writable
  local representations.
- Relations use canonical page/source identity; paths are display hints.
- Datasource page files remain valid standalone NotionMD files.
