# `demo-env` — fresh, self-contained Notion demo environments

`demo-env` provisions a **fully isolated** Notion environment containing
everything the demos need, so both the live presenter and the E2E harness can
spin up envs on demand — parallel, non-colliding, clean takes.

Each env is its own Notion page (under a shared **🧪 Demo Envs** container) plus
its own gitignored local dir + manifest. Two `new` calls never collide → safe
for parallel harness runs.

## What an env contains

Under one env page `env-<timestamp>-<rand>`:

| Demo     | Notion objects                                         | Local |
| -------- | ------------------------------------------------------ | ----- |
| `md`     | 2 pages (Launch roadmap + API spec)                    | `md/roadmap.nmd` (`source: shared`), `md/spec.nmd` (`source: remote`) |
| `sqlite` | 1 typed DB "Launch Tasks" + 6 seed rows                | `sqlite/data/v1/<ds-id>.sqlite` (local replica via `notion db track`) |
| `schema` | 2 typed DBs: `Tasks` + `People` (relation, status, select, date, …) + seed rows | `schema/` (copied `demo/schema/stage/` sources + node_modules) |
| `react`  | 1 target page for JSX rendering                        | `react/page.tsx` (copied, notion-react import absolutized) + node_modules |

Env page children: **3 `child_page`** (roadmap, spec, react) +
**3 `child_database`** (sqlite, Tasks, People) = **6**.

All content is **synthetic** (this is a public repo — never real workspace data).

## Usage

Run inside `devenv shell` (needs `ntn`, `notion`, and `NOTION_API_TOKEN` on PATH):

```bash
# Provision + load into the current shell in one line (the live flow):
eval "$(demo/env/demo-env new --export)"
#   → sets DEMO_* env vars in this shell AND prints the browser links to stderr.
#   → open the links, then drive the demos with the DEMO_* vars set.

# Human-friendly summary + links (no eval), instead of --export:
demo/env/demo-env new --label my-take

# Re-load an existing env into a fresh shell (derived from its manifest):
eval "$(demo/env/demo-env env <env-id> --export)"

demo/env/demo-env list                 # list local envs
demo/env/demo-env rm <env-id>          # trash env page (cascades) + delete local dir
demo/env/demo-env gc --older-than 2h   # rm all envs older than the cutoff (30m/2h/1d)
```

Flags:

- `new --label <name>` — human label (stored in manifest, shown in `list`).
- `new --export` — emit shell `export …` lines on **stdout** (see discipline below).
- `new --no-sqlite-track` — skip the local SQLite replica (faster; DB still created).

### stdout/stderr discipline (important for `eval`)

In `--export` mode, **only** `export KEY='value'` lines go to **stdout**; every
progress log and the links list go to **stderr**. So `eval "$(… --export)"`
captures just the vars, while the presenter still sees the links on the terminal.
Without `--export`, the human summary goes to stdout.

## Exported env vars (`--export`)

Derived purely from the manifest (`manifestToEnvVars` in `manifest.ts`):

| Var | Meaning |
| --- | --- |
| `DEMO_ENV_ID`         | env id (`env-<timestamp>-<rand>`) |
| `DEMO_ENV_PAGE_ID`    | env page id |
| `DEMO_ENV_PAGE_URL`   | env page URL |
| `DEMO_PARENT_PAGE`    | **= env page id** — back-compat alias the existing demo scripts read |
| `DEMO_MD_DIR`         | local md stage dir |
| `DEMO_MD_ROADMAP_ID`  | roadmap page id |
| `DEMO_MD_ROADMAP_FILE`| local `roadmap.nmd` path |
| `DEMO_MD_SPEC_ID`     | spec page id |
| `DEMO_MD_SPEC_FILE`   | local `spec.nmd` path |
| `DEMO_SQLITE_DB_ID`   | sqlite database id |
| `DEMO_SQLITE_DS_ID`   | sqlite data-source id |
| `DEMO_SQLITE_DIR`     | sqlite workspace dir (`cd` here; `notion db sync .` runs from it) |
| `DEMO_SQLITE_PATH`    | local replica file `<dir>/data/v1/<ds-id>.sqlite` (what `sqlite3` opens) |
| `DEMO_SCHEMA_DIR`     | schema stage dir (copied `demo/schema/stage/` sources + node_modules) |
| `DEMO_TASKS_DB_ID`    | schema Tasks database id |
| `DEMO_TASKS_DS_ID`    | schema Tasks data-source id |
| `DEMO_PEOPLE_DB_ID`   | schema People database id |
| `DEMO_PEOPLE_DS_ID`   | schema People data-source id |
| `DEMO_REACT_DIR`      | react stage dir (copied `page.tsx` + node_modules; `cd` here, `bun run page.tsx`) |
| `DEMO_REACT_PAGE_ID`  | react target page id (read by `page.tsx`) |

## Manifest schema

Written to `demo/.demo-envs/<env-id>/manifest.json` (gitignored). It is the
**single source of truth**: `list`, `rm`, `env --export`, and the links list all
derive from it. Shape (`Manifest` in `manifest.ts`):

```jsonc
{
  "envId": "env-20260707-163052-cdfd",
  "label": "my-take",                 // or null
  "createdAt": "2026-07-07T14:31:42.971Z",
  "container": { "id": "…", "title": "🧪 Demo Envs", "url": "…" },
  "envPage":   { "id": "…", "url": "…", "title": "env-… — my-take" },
  "demos": {
    "md": {
      "dir": "…/md",
      "roadmap": { "id": "…", "url": "…", "file": "…/md/roadmap.nmd", "source": "shared" },
      "spec":    { "id": "…", "url": "…", "file": "…/md/spec.nmd",    "source": "remote" }
    },
    "sqlite": { "dbId": "…", "dsId": "…", "url": "…", "dir": "…/sqlite",
                "sqlitePath": "…/sqlite/data/v1/<ds-id>.sqlite", "tracked": true },
    "schema": {
      "dir": "…/schema",
      "tasks":  { "dbId": "…", "dsId": "…", "url": "…" },
      "people": { "dbId": "…", "dsId": "…", "url": "…" }
    },
    "react": { "dir": "…/react", "pageId": "…", "url": "…" }
  }
}
```

## Layout

```
demo/env/
  demo-env        # bash wrapper → `bun demo-env.ts`
  demo-env.ts     # CLI: new / env / list / rm / gc
  notion.ts       # ntn-backed Notion API (global throttle + bounded 429 backoff)
  manifest.ts     # Manifest type + manifest→envVars / →links derivations
  seeds.ts        # consolidated synthetic seed data (single source of truth)
  exec.ts         # child_process helpers (self-contained; no harness import)
demo/.demo-envs/  # gitignored: per-env manifests + local replicas; .container.json
```

The **container id is persisted** in `demo/.demo-envs/.container.json` so repeated
`new` runs reuse the same 🧪 Demo Envs page instead of recreating it. `rm`/`gc`
never touch the container.

## How the harness + demo reset scripts should adopt it

This CLI **consolidates** what the per-demo `setup.sh`/`reset.sh` scripts do into
one source of truth. The intended rewiring (done by a follow-up, not here):

- **Harness:** before a run, call `demo-env new --export` (capture stdout →
  env), drive the demos, then `demo-env rm <id>` (or leave to `gc`). Distinct env
  per run ⇒ parallel, non-colliding. Retention: harness envs are trashed by the
  caller after the run; live/demo envs are kept until `demo-env rm`.
- **Demo stages:** instead of each `reset.sh` creating its own pages/DBs under a
  shared `DEMO_PARENT_PAGE`, source the env: `eval "$(demo-env env <id> --export)"`.
  Because `DEMO_PARENT_PAGE` is set to the **env page id**, existing scripts that
  read `DEMO_PARENT_PAGE` keep working, now scoped to the isolated env. The
  per-demo ids/paths they hardcode into `.demo-state/` are available directly as
  `DEMO_*` vars.

## Known limitation — sqlite local replica

`notion db track` (which establishes the local `.sqlite` replica) currently
**fails closed** on the packaged runtime:

- the flake `notion` wrapper's routing list omits the `track` verb, so it falls
  through to the Bun-unsupported binary (`node:sqlite`), and
- calling the Node-backed runtime directly still exits non-zero with no output.

This is an **upstream regression** that breaks the existing `demo/sqlite/reset.sh`
identically — it is not specific to `demo-env`. `new` therefore **degrades
loudly**: the Notion DB + seed rows are created (fully usable for the demo), the
manifest records `sqlite.tracked: false` and the intended `sqlitePath`, and a
warning prints the exact command to establish the replica once the runtime is
fixed. Tracked upstream in
[#899](https://github.com/overengineeringstudio/effect-utils/issues/899).
