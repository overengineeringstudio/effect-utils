# Mock evidence plan — schema-iac (demo 3.2, PLANNED)

This demo is **narrated with mock output**; the `notion schema plan` / `apply`
commands don't exist, so there is **no harnessed evidence capture** (unlike the
real demos, whose `evidence/<timestamp>/` dirs are produced by the e2e harness).
Everything here is either **hand-authored** or produced **out of band**. Nothing
is a real capture of the (nonexistent) commands. **Do not fabricate Notion
screenshots.**

## Artifacts

| file | kind | status | how produced |
|---|---|---|---|
| `mock/terminal-apply.txt` | terminal output (plan / apply / reconcile / refuse) | **hand-authored, committed** | Written by hand. Uses the real op vocabulary (`+ create`, `+ add property`, `~ add options`, `x BLOCKED`, `applied N changes`) and the real guard names (`DestructiveSchemaMigrationRequired`, `OptionDeletionLosesValues`, `StaleSurfaceBase`). It doubles as the seed spec for the output format. |
| `mock/notion-before.png` | screenshot | **optional, NOT committed** | Out of band: the parent page (or workspace) with **no** "Tasks" database. Plain screenshot of Notion. |
| `mock/notion-after.png` | screenshot | **optional, NOT committed** | Out of band: a "Tasks" database that has the declared properties — created with `ntn api POST /v1/databases` (the same backstage path the codegen demo's `setup.sh` uses), **not** by `notion schema apply`. |
| `mock/terminal-apply.png` | screenshot of the mock terminal | **optional, NOT committed** | If a slide wants an image rather than a text block: screenshot `mock/terminal-apply.txt` rendered in a terminal/editor. It is a picture of hand-authored text, not a capture of a run. |

## Why the images are out of band (and honest)

The Notion "after" state is a database with a title, two selects (with options), a
multi-select, a number, a date, a checkbox, a url, and a rich_text — exactly what
`stage/tasks.notiondb.ts` declares. Producing it via `ntn api` (create-a-database,
API `2026-03-11`, `initial_data_source` shape) yields a **truthful** end state —
the same database the real `apply` would converge to — without pretending the
command did it. The narration must say the screenshots were staged out of band.

Do **not** commit the `.png`s: `demo/.gitignore` already ignores `*/evidence/`,
and screenshots may contain workspace chrome. Keep them local to the recording
machine. The committed, durable artifact is the text mock (`terminal-apply.txt`).

## What NOT to do

- Do not screenshot a real `notion schema apply` run — it doesn't exist and would
  error.
- Do not doctor a Notion screenshot to imply the CLI created it.
- Do not add a `setup.sh` / `reset.sh` here — this demo runs nothing live, and a
  reset script would imply it does. (Contrast the real demos, which drive the
  real binary and need reset scripts.)
