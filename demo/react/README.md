# notion-react demo — declarative Notion pages from JSX

**Primitive:** `@overeng/notion-react` — a `react-reconciler` renderer. You write
a Notion page as a JSX tree (`<Heading1>`, `<Paragraph>`, `<Toggle blockKey=…>`,
…) and `sync()` translates it into the minimum set of Notion block ops
(`append` / `update` / `insert` / `remove`). A persisted cache + stable
`blockKey`s give real declarative diffing: re-rendering the same tree is a no-op,
a one-line change is a single `update`.

**The gap being shown:** the Notion API is imperative — `blocks.append` /
`blocks.update` / `blocks.delete` against block ids. To keep a page in sync you
either wipe-and-re-append every run (visible churn, O(blocks) cost) or hand-roll
a keyed diff + cache. This primitive is that shared layer: **JSX in, minimum
Notion ops out**, with component reuse.

**The wow:** two separate `bun run page.tsx` invocations sharing a persisted
cache. Run 1 (cold) creates the page; edit one line of JSX; run 2 (warm) prints
`updates:1` and only that one block changes in the browser — not a rebuild.

~4 min. See `SCREENPLAY.md` for the exact copy-paste beats. This doc is the
fuller narration + reliability notes.

---

## Layout

```
demo/react/
  stage/page.tsx     # cd here on camera; the editable JSX page + wiring
  bin/create-page.ts # backstage: create the target Notion page (helper)
  bin/archive-page.ts# backstage: archive a page (helper)
  setup.sh           # backstage: symlink deps, create page, record id, clear cache
  reset.sh           # backstage: archive old page + fresh page + clear cache (re-runnable)
  .demo-state/       # gitignored: page-id + notion-cache.json (runtime state)
  node_modules       # gitignored symlink → the package's node_modules (dep resolution)
```

`stage/page.tsx` is the only file shown on camera. The `phases` array near the
top is the edit surface; everything below the component is auth/page-id wiring.

---

## Prerequisites (backstage)

- `devenv shell` — provides `NOTION_API_TOKEN` (secretspec) and `bun` on PATH.
- Dependencies installed once: `devenv tasks run pnpm:install`. This creates the
  package's `node_modules`; `setup.sh` symlinks it so the out-of-package stage
  script can resolve `effect`, `@effect/platform`, `@overeng/notion-effect-client`
  and React.
- `DEMO_PARENT_PAGE` = a Notion page id the token can write under (the shared
  demo page for the real recording; `396e3d41f4a380a98491e1c96f6b5c43` — the
  "Recording" page — for rehearsal).

```bash
devenv shell
export DEMO_PARENT_PAGE=<demo-page-id>
./demo/react/reset.sh            # fresh page + clean cache; prints the page URL
# open that URL in the browser, terminal on the left
```

---

## Beats (narration)

Terminal in `demo/react/stage`, browser open on the target page.

### Beat 1 — Render JSX → Notion
> "A Notion page, written as a React component: a heading, a divider, a toggle
> per launch phase, driven from a plain data array. I run the program…"

```bash
cd demo/react/stage
bun run page.tsx
```

The full page materializes in the browser. Terminal:
`synced → appends:10 updates:0 inserts:0 removes:0 (cold-cache)`.
10 blocks created (4 top-level + 3 toggles + 3 nested paragraphs).

### Beat 2 — Change one line, rerun → diff-only update  ← **the wow**
> "I change one value — the budget, one line of JSX — and rerun the exact same
> command. Watch the terminal and the page."

In `page.tsx`, change the top-level `budget` const (`'$4.2M'` → `'$5.1M'`), then:

```bash
bun run page.tsx
```

Only the intro paragraph changes in the browser. Terminal:
`synced → appends:0 updates:1 inserts:0 removes:0`.
**One `update`.** No wipe, no re-append. The op counts printed next to the page
changing are the proof.

> Why `budget` and not a toggle body: the intro paragraph is a **top-level**
> block, so the change is visible without expanding anything. Notion toggles
> render collapsed by default — editing a nested body is still `updates:1`, but
> the presenter would have to expand the toggle first for it to show.

### Beat 3 — Add a phase → single insert
> "Structure diffs too — I add a fourth phase."

Append one entry to the `phases` array, then `bun run page.tsx`:
`synced → appends:2 …` (the new toggle + its paragraph; nothing else touched).

### Beat 4 (optional) — No-op resync
> "And re-rendering an unchanged tree is a genuine no-op — the stable
> `blockKey` on each toggle is what makes the diff exact across runs."

`bun run page.tsx` → `appends:0 updates:0 inserts:0 removes:0`.

---

## Between takes

```bash
./demo/react/reset.sh
```

Archives the previous page, creates a fresh empty one, records the new id,
**clears the cache**, and **restores `stage/page.tsx`** to its committed state.
All three matter: a cache pointing at an archived page produces wrong op counts,
and an un-restored `page.tsx` still carrying take-1 edits breaks Beat 1's counts
and Beat 2's instruction. (The file-restore only fires once `page.tsx` is
committed; until then, revert edits by hand between takes.)

---

## Reliability — honest assessment

**Verdict: reliable enough to include.** Tested end-to-end from clean seed
against live Notion (rehearsal parent `396e3d41f4a380a98491e1c96f6b5c43`): cold
`appends:10` → 1-line body edit `updates:1` → add phase `appends:2` → no-op
`0/0/0/0`, then `reset.sh` → clean cold `appends:10` again. Blocks verified
present on the live page via the Notion API.

Risks and mitigations:

- **Dep resolution is non-obvious.** The repo uses pnpm's *isolated* linker, so
  the stage script (outside the package) can't resolve `react`/`effect` from a
  root `node_modules` — there isn't one. `setup.sh` fixes this with a symlink to
  the package's `node_modules`, and `page.tsx` imports `@overeng/notion-react`
  via a relative source path. This is prepared backstage; nothing to do on
  camera. If `pnpm:install` hasn't run, `setup.sh` fails fast with a clear
  message.
- **Stale cache is the top between-takes failure.** Always use `reset.sh` (not
  `setup.sh`) between takes — it clears the cache. Never hand-edit `.demo-state`.
- **Network / Notion API latency.** Each `bun run` is a handful of API calls
  (~1–3 s). The library already retries 429s. Keep the demo parent lightly
  loaded; avoid running other Notion tooling against the same workspace mid-take.
- **`pnpm:install` via the devenv task crashes** in this environment (a libuv
  fd assertion in the task wrapper) but the underlying install completes; if the
  task shows a red abort, verify `packages/@overeng/notion-react/node_modules/effect`
  exists and proceed. Do this well before recording, not live.
- **Not exercised by the package's own tests:** the e2e suite does two syncs in
  *one* process with an in-memory cache. This demo is two *processes* sharing an
  on-disk `FsCache` — a different path (cache JSON round-trip + `blockKey`
  stability across a process boundary). That exact flow is what the manual
  end-to-end test above validated; re-run Beats 1–2 once before recording.

The whole demo is real commands against real Notion — no wrapper scripts, no
mocks. The visible op-count line (`updates:1`) beside the page changing is the
crisp, repeatable wow.
