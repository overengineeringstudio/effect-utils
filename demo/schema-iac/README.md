# notion schema apply — declarative IaC provisioning (demo 3.2, PLANNED)

> **This capability does not exist yet.** This directory is a *roadmap preview*:
> a designed, honest illustration of where `notion schema` is headed. The
> presenter **narrates** it and shows **mock** output — no command here runs live
> (running `notion schema apply` / `notion schema plan` would fail; they aren't
> built). Read `SCREENPLAY.md` for the on-camera script.

## What it is (and what 3.1 already is)

`notion schema` today is **introspect → codegen → drift detection**: the live
Notion database is the source of truth, `notion schema generate` emits typed
Effect code from it, and `notion schema diff --exit-code` gates drift in CI. That
is the shipped demo in `demo/schema/` ("3.1").

This preview ("3.2") is the **inverse**: a declarative schema **file** is the
source of truth, and a planned `notion schema apply` **provisions and reconciles**
the Notion database to match it — the IaC direction.

| | 3.1 codegen (real, today) | 3.2 IaC (this, planned) |
|---|---|---|
| Source of truth | live Notion DB | the `.notiondb.ts` file |
| Direction | DB → typed code | file → Notion DB |
| Commands | `generate`, `generate-config`, `diff` | `plan`, `apply` |
| CI gate | `diff --exit-code` (code drifted from DB) | `plan --exit-code` (DB drifted from file) |

## The declarative file

`stage/tasks.notiondb.ts` is the source-of-truth artifact — a typed desired-state
definition of a "Tasks" database (title, two selects with options, a multi-select,
number, date, checkbox, url, rich_text). `stage/notiondb.ts` is a **sketch of the
proposed `@overeng/notion-cli/iac` module** (`defineDatabase`, `property`,
`parentPage`, and the `DatabaseSpec` / `PropertyType` Effect Schema) so the file
type-checks and reads as a real extension. Both carry loud "PROPOSED / does not
exist yet" headers. The sketch has **no apply logic** — it describes shape only.

Why a local sketch instead of importing `@overeng/notion-cli/iac`: that module
doesn't exist, and (like the codegen demo's config) the demo stage isn't in the
repo's build graph, so a self-contained local import keeps the artifact honest and
non-breaking. It doubles as the **seed spec** for the real feature.

## The honest boundary (this is the whole point)

The proposed command surface is scoped to exactly what the existing engine can
already do — nothing more.

**In scope (buildable on today's plumbing):**

- **create database if absent** — `NotionDatabases.create` already exists
  (`packages/@overeng/notion-effect-client/src/databases.ts`) with **zero
  production callers**; `apply` would be its first real user.
- **add property** — of the exact conservative subset the sync engine supports:
  `rich_text, number, checkbox, date, url, email, phone_number, people, select,
  multi_select` (see `AddPropertyDefinition`).
- **rename property** — via `RenameProperty` (needs an explicit `renamedFrom`
  hint in the file; see below).
- **add select / multi_select options** — via `AddSelectOptions` (append-only).

**Out of scope — fails closed, by design:**

- delete a property, change a property type, remove a select option — these have
  **no representation** in the engine's `SchemaPatchOperation` union, so they
  fail at decode; and the domain guard `guardSchemaIntentSafety` blocks them with
  `DestructiveSchemaMigrationRequired` / `OptionDeletionLosesValues`.
- `title` is create-only (every data source has exactly one; Notion won't retype
  it), and `status`, `relation`, `files`, `formula`, `rollup` and all computed
  types are excluded because the engine can't safely provision them.

A declarative front-end must not weaken these guards; `plan` surfaces blocked ops
and `apply` refuses the whole run rather than partially applying.

## The half-built plumbing this rests on

Everything the mock output claims maps to real code (verified in this repo):

- **`SchemaPatchOperation`** union — `AddProperty` / `RenameProperty` /
  `AddSelectOptions` — and **`AddPropertyDefinition`** (the supported type
  subset): `packages/@overeng/notion-datasource-sync/src/core/commands.ts`.
  Destructive shapes are deliberately absent from the union.
- **`CanonicalOptionValue`** (the `{ name, color? }` option shape the file's
  `OptionSpec` mirrors): `packages/@overeng/notion-effect-schema/src/properties/canonical.ts`.
- **Translation → Notion**: `dataSourceOperationsToNotion` →
  `client.updateDataSource` → Notion `update_data_source`, base-hash gated
  (`guardStaleSurfaceBase`, guard `StaleSurfaceBase`):
  `packages/@overeng/notion-datasource-sync/src/gateway/notion.ts`.
- **Destructive guards**: `guardSchemaIntentSafety`
  (`packages/@overeng/notion-datasource-sync/src/core/guards.ts`) →
  `DestructiveSchemaMigrationRequired`, `OptionDeletionLosesValues`; adapter
  `unsupportedOperation` → `UnsupportedRemoteShape`.
- **Create-a-database**: `NotionDatabases.create`
  (`packages/@overeng/notion-effect-client/src/databases.ts`) — exists, zero
  production callers.
- **Command idiom** to slot `plan`/`apply` into: `Command.make(...)` +
  `Command.withSubcommands([...])` in
  `packages/@overeng/notion-cli/src/commands/schema/mod.ts`.

## What the real feature would still need (not built)

- A **planner** that diffs a decoded `DatabaseSpec` against a live data source
  schema and emits `SchemaPatchOperation`s (add/rename/add-options) plus a
  "create database" step when absent, and classifies everything else as blocked.
- A **state model** mapping the file to the database it owns — proposed here as a
  `tasks.notiondb.lock.json` (Terraform-style), with `--database <id>` as an
  explicit override. **This is the least-settled part of the design** (see
  `INTEGRATION.md` / the report).
- `plan` / `apply` subcommands and their renderers, following the existing
  `notion schema` TUI idiom.
- `Schema.decodeUnknownSync(DatabaseSpec)` validation in the config loader
  (today's loader only structurally validates).

## Mock evidence

See `MOCK-EVIDENCE.md`. The terminal output is hand-authored
(`mock/terminal-apply.txt`); the only real Notion artifacts (optional before/after
screenshots) are produced **out of band** via `ntn api`, never by these commands.
Do not fabricate Notion screenshots.

## Files

```
demo/schema-iac/
  README.md                    # this file — honest boundary + plumbing pointers
  SCREENPLAY.md                # the narrated, mock-output on-camera script
  MOCK-EVIDENCE.md             # which images are needed + how to produce them
  INTEGRATION.md               # note for later app-registry wiring
  mock/
    terminal-apply.txt         # hand-authored mock terminal output (plan/apply/refuse)
  stage/
    tasks.notiondb.ts          # the desired-state SOURCE OF TRUTH (seed spec)
    notiondb.ts                # PROPOSED @overeng/notion-cli/iac module sketch
```
