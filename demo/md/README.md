# notion md — demo (watch-mode hero)

A ~7-minute, repeatable, live-drivable demo of `@overeng/notion-md`: two-way
Markdown ⇄ Notion sync with a guarded 3-way merge and a watch daemon.

The presenter drives the **real** `notion md` CLI on camera. `SCREENPLAY.md` is
the tight copy-paste version (it gets turned into a Notion page to read from
live). This file is the fuller script with the framing and the rough edges.

## The platform gap

Notion pages have no local source of truth. You can't open a page in your
editor, keep it in Git, diff it, or let a teammate's Notion edit and your local
edit meet without one silently winning. `notion md` makes a `.nmd` file the
local half of a page and reconciles the two — safely.

## The wow

Start **one** watcher over two files. Then never touch the CLI again for the
core beats: save locally → Notion updates; edit in Notion → local updates; edit
the **same line** on both sides → it writes a `*.conflict.roughdraft.md` with
base/local/remote instead of clobbering.

## Anatomy of this folder

| Path | Role |
| --- | --- |
| `seed/roadmap.nmd`, `seed/spec.nmd` | committed clean start; synthetic; `source: local`, `page_id: null` (public-repo safe) |
| `stage/` | working dir the presenter `cd`s into; filled by reset from the seed; gitignored |
| `reset.sh` | backstage: trash last run's pages, create 2 fresh pages, bind sources, verify, print URLs |
| `setup.sh` | backstage: first-time — build the CLI if needed, then `reset.sh` |
| `.demo-state/` | backstage: the two live page ids/urls (gitignored) |

Two files, two `source` modes — this is deliberate and on-message:

- `roadmap.nmd` is **`source: shared`** — a doc *you* own: you author locally,
  guarded push to Notion, 3-way merge on conflict. Beats 1 and 3.
- `spec.nmd` is **`source: remote`** — a doc your *team* authors in Notion:
  it mirrors down into the repo. Beat 2 (the reverse direction).

> Why the seed is `source: local` + `page_id: null`: a committed file can't
> carry a real page id in a public repo, and the `.nmd` schema rejects
> `shared`/`remote` with a null id. So the seed is the only legal unbound shape
> (`local` + null = create-on-push) and `reset.sh` converts each file to its
> demo source with `notion md track … --as <source>` right after creating the
> page.

## Backstage (before recording — not on camera)

```sh
devenv shell
export DEMO_PARENT_PAGE=<demo parent page id>   # the shared demo env page
./demo/md/setup.sh        # first time (builds if needed) — or ./demo/md/reset.sh for later takes
```

`reset.sh` prints the two fresh page URLs. Open both in the browser. Arrange:
terminal + editor left, the two Notion pages right, so propagation is visible.

## On camera — the beats (~7 min)

Every command below is literally what the presenter types. `notion md` is on
`PATH` inside `devenv shell` (the umbrella binary).

### Beat 0 — start the daemon (~1 min)

> "One command watches two local files and keeps them in sync with Notion.
> There's no push or pull verb — direction lives in each file's `source`."

```sh
cd demo/md/stage
notion md sync --watch roadmap.nmd spec.nmd --poll-interval-ms 3000
```

Leave it running. It prints one compact JSON line per pass; the visible payoff
is on the Notion pages and in the editor, not the log.

### Beat 1 — local edit → Notion, live (~1.5 min)  ·  `source: shared`

> "Gap: you can't edit a Notion page from your editor. Here I just check a box
> and save — and watch pushes it to Notion."

Edit `roadmap.nmd`, check the first box, save:

```
- [ ] Finalize the API spec   →   - [x] Finalize the API spec
```

Watch prints `shared-merged`; the **Launch roadmap** page ticks the box. **Wow.**

### Beat 2 — Notion edit → local, live (~1.5 min)  ·  `source: remote`

> "The reverse. `spec.nmd` mirrors a page the team authors in Notion. I add an
> endpoint in the browser — seconds later it's in my repo, no command."

In the browser on the **API spec** page, add a bullet:

```
- DELETE /v1/pages
```

Within ~1–2 poll cycles watch prints `pulled` and `spec.nmd` shows the new
endpoint locally. **Wow.**

### Beat 3 — same line, both sides → guarded merge (~2 min)  ·  the money beat

> "The case every naive sync gets wrong: my teammate and I edit the same line at
> once. Watch it refuse to clobber."

Stop the watcher (`Ctrl-C`), then diverge the **same line**:

- In the browser (**Launch roadmap**): `On track for the Q3 release.` →
  `Slipping — blocked on review.`
- In the editor (`roadmap.nmd`): same line → `Ready to ship today.`, save.

```sh
notion md sync roadmap.nmd
```

It prints `shared-conflict` and writes the artifact — Notion is **untouched**:

```sh
cat roadmap.nmd.conflict.roughdraft.md
```

Base / Local / Remote, side by side. **Wow.** Resolve by editing `roadmap.nmd`
to the intended final line, delete the roughdraft, and `notion md sync` again.

### Bonus (if time) — non-overlapping edits auto-merge

Restart the watcher; edit a *different* line in Notion and a *different* line
locally. Watch prints `shared-merged` and keeps **both** — a conflict only
happens when edits actually overlap.

## Rough edges / risks for the live run

- **Command form is `--watch <file> <file>`, not `--watch .`.** A single
  directory arg (even `.` with `--recursive`) is read as one `.nmd` file and
  errors — the two explicit filenames route to the batch watcher, which is what
  drives both push and pull in one session. Verified against this build.
- **Beat 2 timing.** A browser edit autosaves on a debounce and the API
  read-after-write can lag a second or two; the first poll may be a `noop` and
  the `pulled` lands on the next cycle. Pace it — don't retype. `--poll-interval-ms 3000`
  keeps it snappy without racing beat 3.
- **Beat 3 is intentionally a one-shot** (`Ctrl-C` first). Under a running
  watcher a fast poll can pull the remote edit before your local edit lands,
  turning the conflict into a plain pull. Stopping the watcher makes it
  deterministic; the order (Notion edit → local edit → `sync`) matters.
- **Overlap for the conflict.** Beat 3 only conflicts if both edits hit the
  **same line**. Different lines auto-merge (that's the bonus, not the conflict).
- **Reset between takes.** `./reset.sh` is idempotent — it trashes the prior
  run's two pages and makes fresh ones, so takes never accumulate under the
  parent.

## Public-repo safety

Everything in `seed/` is synthetic. No real page ids, tokens, or private
content are committed: the parent page id is injected from `$DEMO_PARENT_PAGE`
at reset time, live page ids live only in gitignored `stage/` and `.demo-state/`.
