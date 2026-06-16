# Streaming `--frontmatter` detects schema drift via an in-buffer schema fingerprint

> **Superseded by [0017](./0017-edit-is-an-ephemeral-file-engine-session.md).** The
> in-buffer fingerprint existed only because a stateless pipe has no base snapshot.
> Under Option 2, structured property editing moves to `edit --frontmatter`
> (engine-backed, with a base snapshot) or the file-based `sync`; stateless `put
--frontmatter` is dropped. So drift is detected by snapshot comparison (a
> `schema_snapshot` sidecar role), and this whole fingerprint subsystem (plus R42
> and impl-delta Group F) is deleted. Retained for history — the live findings here
> (data_source_id recovery, the hashable subset, the silent select-option
> auto-create) inform the engine's `schema_snapshot` comparison.

R14 requires a property write to refuse when the data-source schema changed since
the last clean pull. The file-based path detects this from its stored base
snapshot, but the streaming surface is stateless (decision 0008) — no state
store, no base snapshot.

Decision: `cat --frontmatter` on a **data-source-backed page** emits a **schema
fingerprint** (a hash of the parent data source's property schema at read time)
into the frontmatter envelope, alongside the base hash. `put` re-reads the live
schema, recomputes the fingerprint, and refuses with **exit 6**
(`NmdSchemaDriftError`) if it differs. Standalone pages have no data-source
schema, so the fingerprint is absent and the check does not apply.

This keeps drift detection stateless and consistent with the base-hash-in-buffer
model: the fingerprint rides in the same envelope the user already holds. It is
kept **distinct from the exit-7 value/body conflict** because a schema change
needs explicit re-pull-and-review (R14's "explicit acceptance"), not a `--force`.

Live-verified (experiments.md; tmp/notion-vim/schema-fingerprint-verify.md):

- **Stateless recovery works:** `page.parent` carries `data_source_id` (and
  `database_id`) directly, so `put` recovers the exact data source from the
  buffer alone. The schema lives on `GET /v1/data_sources/{id}` (the
  2025-09-03+ split; `GET /databases/{id}` no longer returns `properties`).
- **Exact hashable subset:** a canonical projection **sorted by property name**
  of `{ name, type, sorted option *names* }`, options only for
  `select`/`multi_select`/`status`. Hash **names, not ids** — a rename is
  id-preserving, so id-hashing would silently miss renames. **Exclude** property
  ids, option ids, colors, descriptions, status groups, all timestamps,
  `created_by`/`last_edited_by`, `request_id`, title/url/is_inline/is_locked
  (`request_id` is the only volatile field in an unchanged read).
- **Not redundant with Notion validation:** writing a `select` value with an
  unknown option name returns **HTTP 200 and silently auto-creates the option**,
  corrupting the schema. The fingerprint is the only precise pre-write guard;
  removed/renamed/retyped properties 400 on their own but late and scattered.
- **Writable set** is `propertyWriteClassFromType` / `PROPERTY_WRITE_CLASSES`
  (`@overeng/notion-core`), confirmed against live behavior (formula / rollup /
  `unique_id` / button / created* / last_edited* reject writes).
- **Fingerprint scope:** hash the **writable-property subset's** schema (a
  computed-only schema change cannot affect a write, so it should not trip drift)
  — tighter and consistent with the writable-projection guard (decision 0006).
- **Conservative over-refusal:** adding a new option trips the fingerprint though
  it is benign for existing values; the remedy is a cheap re-pull. Accepted.

## Status

superseded by 0017 (was: accepted, live-verified)

## Consequences

- Only `--frontmatter` mode on data-source-backed pages carries the fingerprint;
  default mode and standalone pages do not.
- The fingerprint envelope field is **excluded from the base-hash projection**
  (decision 0006 / Guard plumbing), so a schema change trips exit 6 only, never
  also exit 7 — keeping the two guards on distinct axes.
