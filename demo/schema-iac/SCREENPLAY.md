# notion schema apply — declarative IaC provisioning (Screenplay)

> **PLANNED / NOT YET BUILT — roadmap preview.** `notion schema apply` and
> `notion schema plan` **do not exist yet.** The presenter **narrates** this beat
> and shows **mock** terminal output + before/after Notion screenshots. **No
> command in this screenplay is run live** — running them would fail. This is an
> honest preview of where the tool is going, not a demo of shipped behavior.

Gap: today the Notion database is the source of truth and you generate code *from* it (that's the shipped `notion schema generate` demo — "3.1"). But there's no way to go the other direction: declare the database you *want* in a file and have the tool provision and reconcile Notion to match.
Wow (planned): write a database as a typed file, run `notion schema plan` to see exactly what it would create or change, then `notion schema apply` to make Notion match — additive and safe, with destructive changes refused. The inverse of codegen. ~5 min, narrated.

## Status — say this on camera, up front

> "Everything I'm about to show is a **preview of planned work** — these commands
> aren't built yet, so I'm not going to run them. What *is* real is the engine
> underneath: the sync layer already knows how to add a property, rename one, and
> extend select options against a live Notion database, and it already refuses
> destructive changes. This beat is about the declarative front-end we'd put on
> top of that."

## Backstage (before recording — not on camera)

- Open `demo/schema-iac/stage/tasks.notiondb.ts` and `demo/schema-iac/stage/notiondb.ts` in the editor.
- Have `demo/schema-iac/mock/terminal-apply.txt` open in a second pane (the mock outputs you'll show).
- Optional visuals: a `notion-before.png` (an empty/parent page with no "Tasks" DB) and a `notion-after.png` (a "Tasks" DB with the declared properties). These are produced **out of band** via `ntn api` — see `MOCK-EVIDENCE.md`. Never present them as live.
- `cd` into the stage so the paths on screen are short:

```sh
cd demo/schema-iac/stage
```

## On camera (narrated — commands are SHOWN, not run)

### Beat 1 — The declarative source of truth   say: "Here's the whole database as a file. Not generated *from* Notion — this is what I *want* Notion to be. Title, two selects with their options, a multi-select, a number, a date, a checkbox, a URL, some notes."

Show the desired-state file:

```sh
cat tasks.notiondb.ts
```

Point at it, top to bottom: `name: 'Tasks'`, the `parent` comes from an env var (no id committed), and each property is one line — `property.select({ options: [...] })`, `property.number(...)`, `property.checkbox()`. Then note the shape is real:

> "These property builders aren't decorative — they map one-to-one to what the
> sync engine can already add to a live database. There's deliberately no
> `formula`, no `relation`, no `status` here, because the engine can't safely
> provision those. The file can only say things the tool can actually do."

### Beat 2 — `notion schema plan` shows the diff   say: "Before touching anything, I ask for a plan — like `terraform plan`. It reads the file, looks at Notion, and prints exactly what it would do. Nothing is created yet."

The command (shown, not run):

```sh
notion schema plan tasks.notiondb.ts
```

It would print (mock — this is the planned output, hand-authored):

```
Plan  ·  tasks.notiondb.ts  →  Notion
target: create new database (no tasks.notiondb.lock.json yet)

  + create database "Tasks"   (parent: page $DEMO_PARENT_PAGE)
      + property "Name"         title
      + property "Status"       select        Todo | In Progress | Done
      + property "Priority"     select        High | Medium | Low
      + property "Tags"         multi_select  bug | feature | chore
      + property "Estimate"     number
      + property "Due Date"     date
      + property "Done"         checkbox
      + property "Ticket URL"   url
      + property "Notes"        rich_text

Plan: 1 database to create, 9 properties to add, 0 to change, 0 blocked.
```

> "Every line here corresponds to a real operation the engine supports. It found
> no existing database, so the whole plan is additive: create the DB, add nine
> properties. A `+` is something it will add; there are no `~` changes and
> nothing blocked yet."

### Beat 3 — `notion schema apply` provisions, then reconciles   say: "Now apply. First run creates the database; the second run — after I edit the file — reconciles just the delta. Same file, converged twice."

The apply (shown, not run):

```sh
notion schema apply tasks.notiondb.ts
```

Mock output:

```
  + create database "Tasks" … done   2f1e…c43   https://www.notion.so/2f1e…c43
  + add 9 properties … done
  · wrote tasks.notiondb.lock.json   (records the created database id)

applied 10 changes.
```

Switch to the browser and show the **after** state — the "Tasks" database now exists with all nine properties (mock `notion-after.png`; produced out of band).

> "It created the database, added every property, and wrote a lockfile so it
> knows which Notion database this file owns. That lockfile is how a *second*
> apply becomes a reconcile instead of a duplicate."

Now edit the file on camera — add `'Urgent'` to `Priority` and a new `Blocked` checkbox — and re-plan:

```sh
notion schema plan tasks.notiondb.ts
```

Mock output — only the delta, matched against the recorded database:

```
Plan  ·  tasks.notiondb.ts  →  Notion
target: 2f1e…c43   (from tasks.notiondb.lock.json)   base schema hash: match

  ~ database "Tasks"
      ~ add options to "Priority"   (+ Urgent)
      + property "Blocked"          checkbox

Plan: 0 to create, 1 property to add, 1 to change, 0 blocked.
```

> "It didn't propose recreating anything. It diffed the file against the live
> schema and found exactly two additive changes — one new option, one new
> property. `apply` again would make just those. That's reconciliation: the file
> is the desired state, the tool moves Notion toward it, and re-running when
> nothing changed is a no-op."

### Beat 4 — The honest boundary: additive only, destructive fails closed   say: "Here's the important part, and it's why this is safe to even consider. The tool will only ever *add*. Anything that could lose data is refused — it fails closed, exactly like the sync engine does today."

Suppose the file dropped `Notes`, retyped `Estimate`, and removed a `Priority` option. `plan` marks each one blocked (mock):

```
  ~ database "Tasks"
      x remove property "Notes"                    BLOCKED  DestructiveSchemaMigrationRequired
      x change "Estimate"  number → rich_text       BLOCKED  DestructiveSchemaMigrationRequired
      x remove option "Low" from "Priority"        BLOCKED  OptionDeletionLosesValues

Plan: 0 to create, 0 to add, 0 to change, 3 blocked.
```

And `apply` refuses the whole run rather than doing the safe parts and stranding the rest (mock):

```
Error: refusing to apply — 3 destructive change(s) are out of scope.
       `notion schema apply` performs additive, non-destructive reconciliation
       only (create-db, add property, rename property, add select options).
       Nothing was changed.
```

> "Those guard names — `DestructiveSchemaMigrationRequired`,
> `OptionDeletionLosesValues` — aren't invented for the slide. They're the actual
> guards in the sync engine today. A declarative front-end doesn't get to weaken
> them. So the scope is: create a database, add properties, rename properties,
> extend select options. Deletes, type changes, option removals — you do those
> deliberately in Notion, never as a silent side effect of editing a file.
> **And to be clear one more time: this front-end is planned work — the engine
> exists, the `plan`/`apply` commands don't yet.**"

## Reset between takes (backstage)

Nothing to reset — no commands are run and no state is written. Just re-open
`tasks.notiondb.ts` in its original form (revert the Beat 3 edits) and the mock
output file. If you produced real before/after Notion pages via `ntn api`, trash
them the same way the other demos do (`ntn api` DELETE / archive).
