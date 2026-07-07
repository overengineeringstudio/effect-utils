# notion schema (codegen) — Screenplay

Gap: Notion hands you untyped JSON; you want end-to-end typed access to your databases in code.
Wow: point at a live DB and seconds later you have typed, autocompleting Effect schemas — with literal-union option types, write schemas, a typed API wrapper, and CI drift detection. ~6 min.

## Backstage (before recording)

- `devenv shell` (so the packaged `notion` binary is on PATH)
- `export DEMO_PARENT_PAGE=<a Notion page shared with the "Notion CLI" integration>`
- `./demo/schema/reset.sh` — trashes any old demo DBs, creates 2 synthetic typed DBs
  ("Tasks" + "People"), writes their ids to `demo/schema/.demo-state/`, and links
  `stage/node_modules` for editor autocomplete
- Open both DBs in the browser (urls printed by reset.sh; also in `.demo-state/*-url`)
- Open `demo/schema/stage/` in your editor, split: `schema.gen.ts` | `use-schema.ts`

## On camera (copy-paste in order)

### Beat 1 — Generate typed bindings from a live DB say: "Notion gives you JSON. Here's the whole database as a typed Effect schema — generated, not written."

```
cd demo/schema/stage
```

```
notion schema generate-config
```

Then open `schema.gen.ts` and scroll. Point out, top to bottom:

- literal-union option types: `TasksPriorityOption = Schema.Literal('High','Low','Medium')` (came from the DB's select options)
- the read schema `TasksPageProperties` with JSDoc pulled from each property's description
- the write schema `TasksPageWrite` + `encodeTasksWrite` (create/update)
- a second file `schema.gen.api.ts` — a typed `query` / `get` / `create` / `update` wrapper

### Beat 2 — Use them, with autocomplete say: "And now the payoff in your own code — real autocomplete, real compile errors."

Open `use-schema.ts`. Hover `task.Priority`, trigger completion on `p.name` — the editor offers `'High' | 'Medium' | 'Low'`. Type a bad option name to show the red squiggle. (Nothing here is hand-written types; it all flows from `schema.gen.ts`.)

### Beat 3 — Schema-as-code for the whole workspace say: "One command didn't just do Tasks — this config lists every database; regenerate them all at once."

```
cat notion-schema-gen.config.ts
```

Point at the two databases in the config, then show the second generated file it produced:

```
code people.gen.ts   # or: open people.gen.ts in the editor
```

(Optional re-run to show it's idempotent regeneration, not a one-off:)

```
notion schema generate-config
```

### Beat 4 — Gate drift in CI say: "The codegen payoff: your code and your Notion DB can silently diverge. Catch it."

First show they're in sync:

```
notion schema diff "$(cat ../.demo-state/tasks-db-id)" --file schema.gen.ts --exit-code
```

Now change the DB in the Notion UI on camera — add a new property to "Tasks" (e.g. a "Blocked" checkbox). Then re-run:

```
notion schema diff "$(cat ../.demo-state/tasks-db-id)" --file schema.gen.ts --exit-code
```

It prints `+ Blocked (checkbox)` and **exits 1**. Say: "Drop that one command in CI and nobody changes your database schema without your generated code failing the build."

## Honesty (say it out loud once)

This is **introspect → codegen → drift detection**, not declarative provisioning. The tool reads a live Notion database and generates typed code; it does not create or alter the database from TypeScript. (Creating the demo DBs is done backstage with `ntn api`.)

## Reset between takes

```
./demo/schema/reset.sh
```

Recreates a clean DB pair and removes generated files. Re-runnable.
