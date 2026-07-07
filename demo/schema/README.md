# notion schema — IaC demo

Showcase of `notion schema` (part of `@overeng/notion-cli`): point at a live Notion
database and get typed, autocompleting Effect schemas — literal-union option types,
write schemas, a typed API wrapper, and CI drift detection.

**The script is [`SCREENPLAY.md`](./SCREENPLAY.md)** — numbered beats, exact copy-paste
commands, one-line narration. Start there.

## Layout

```
demo/schema/
  SCREENPLAY.md         # the on-camera script (start here)
  setup.sh              # BACKSTAGE: create the 2 synthetic typed DBs via `ntn api`
  reset.sh              # BACKSTAGE: trash old DBs + generated files, re-run setup, link node_modules
  .demo-state/          # gitignored: created DB ids + urls (written by setup.sh)
  stage/                # the prepared working dir the presenter cd's into on camera
    notion-schema-gen.config.ts  # committed: declares Tasks + People (schema-as-code)
    use-schema.ts                # committed: tiny consumer showing autocomplete / type-safety
    tsconfig.json                # committed: makes the stage resolve types for the editor
    package.json                 # committed: {"type":"module"} so the config typechecks
    .gitignore                   # ignores generated *.gen.ts / *.gen.api.ts + node_modules
    schema.gen.ts / people.gen.ts (+ .api.ts)  # GENERATED live in Beat 1/3 (gitignored)
    node_modules -> ...notion-cli/node_modules # gitignored symlink (created by reset.sh)
```

Backstage scripts (`setup.sh`, `reset.sh`) are **never shown on camera** — the presenter
drives the real `notion` binary directly from `stage/`.

## Prerequisites

- `devenv shell` (packaged `notion` on PATH) and `ntn` authenticated.
- `export DEMO_PARENT_PAGE=<page id shared with the "Notion CLI" integration>` before
  running `reset.sh`. Fully parameterized — no page id is hard-coded.

## Synthetic seed

Two databases are created under `$DEMO_PARENT_PAGE` via `ntn api` POST `/v1/databases`
(the modern `initial_data_source` shape, API `2026-03-11`):

- **Tasks** — title, status, select (Priority), multi_select (Tags), date, number,
  checkbox, url, rich_text, relation (Assignee → People). Every property carries a
  description, which becomes JSDoc in the generated schema.
- **People** — title, select (Role), email, checkbox. The relation target.

All content is **synthetic** (this is a PUBLIC repo). The committed
`stage/notion-schema-gen.config.ts` references both DBs by reading their ids from
`.demo-state/` at load time, so it never hard-codes a throwaway id.

## Honesty

`notion schema` is **introspect → codegen → drift detection**, not declarative
provisioning: it reads a live database and generates typed code; it does not create or
alter the Notion DB from TypeScript. DB creation lives in the backstage `ntn api` scripts.

## Implementation notes

- **`schemaMeta: false` in the config (and no `--schema-meta` in Beat 3):** keeps generated
  fields one-line so `schema diff` can parse them. The diff parser reads
  `Prop: NotionSchema.x` fields and does not understand fields wrapped in
  `.annotations({ [notionPropertyMeta]: … })`. With `schemaMeta:false` the file still emits
  typed literal unions + JSDoc, and `diff` works. (Beat 1's single `generate` runs with
  schema-meta on for a richer file; Beat 3 regenerates `schema.gen.ts` with it off, so run
  **Beat 4's diff after Beat 3**.)
- **`schema diff` detects property add/remove/type-change, not select-option changes**
  (options comparison is not implemented). Beat 4's drift is therefore adding a *property*
  (a "Blocked" checkbox), which is the right IaC story anyway.
- **Config is a plain object, not `defineConfig(...)`:** the packaged `notion` binary loads
  the `.ts` config at runtime and its resolver can't reach this workspace's `@overeng/*`
  source packages from an external file, so importing `@overeng/notion-cli/config` (or its
  source) fails under the packaged binary. A plain config object (no package imports) loads
  cleanly. Real users who install `@overeng/notion-cli` as a dependency get the type-safe
  `defineConfig` / `file` helpers — see the comment at the top of the config file.
- **`stage/node_modules` symlink + `@types/node`:** `reset.sh` links the notion-cli package's
  `node_modules` into `stage/` so the editor resolves `effect` / `@overeng/notion-effect-schema`
  and autocomplete/typecheck light up. Verified with `tsc --noEmit`.
