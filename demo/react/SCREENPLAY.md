# notion-react — Screenplay
Gap: Notion's API is imperative block ops — no declarative "here's the page I want" with component reuse. Wow: run a JSX program → the page appears; change one line + rerun → only that block updates (op counts prove it). ~4 min.

## Backstage (before recording — not on camera)
- `devenv shell`                     # provides NOTION_API_TOKEN + bun on PATH
- `eval "$(demo/env/demo-env new --export)"`   # fresh target page + a self-contained $DEMO_REACT_DIR (page.tsx + node_modules); sets DEMO_* + prints links
- open the printed **react · target page** link in the browser
- one-time only, if node_modules is missing: `devenv tasks run pnpm:install`

## On camera (copy-paste in order)
### Beat 1 — Render JSX → Notion   say: "This is a Notion page written as a React component — headings, a divider, a toggle per launch phase. I run the program…"
```
cd "$DEMO_REACT_DIR"
```

```
bun run page.tsx
```
(Browser: the whole page materializes. Terminal prints `synced → appends:10 updates:0 inserts:0 removes:0 (cold-cache)` — 10 blocks created.)

### Beat 2 — Change one line, rerun → diff-only update   say: "I'll change one value — the budget, one line of JSX — and rerun the exact same command."
Edit `page.tsx`, change the top-level `budget` const:
```text
const budget = '$5.1M'
```
```
bun run page.tsx
```
(Browser: only the intro paragraph changes — it's top-level so it's visible without expanding anything. Terminal prints `synced → appends:0 updates:1 inserts:0 removes:0` — a single `update`, not a rebuild. This is the wow.)

### Beat 3 — Add a phase → single insert   say: "Same deal for structure — I add a fourth phase and rerun."
Edit `page.tsx`, append to the `phases` array:
```text
  { id: 'p4', title: 'Phase 4 — Post-launch review', body: 'debrief and retro' },
```
```
bun run page.tsx
```
(Browser: one new toggle appears at the end. Terminal prints `synced → appends:2 …` — just the new toggle + its nested paragraph. Everything else untouched.)

### Beat 4 (optional) — Rerun unchanged → zero ops   say: "And re-rendering an unchanged tree is a genuine no-op."
```
bun run page.tsx
```
(Terminal prints `synced → appends:0 updates:0 inserts:0 removes:0`. The stable `blockKey` on each toggle is what makes the diff exact across separate runs.)

> Between takes (backstage): `eval "$(demo/env/demo-env new --export)"` — a fresh env gives a new empty page, an empty cache, and a fresh copy of `page.tsx` (so `budget` is back to `$4.2M` and no p4). The old env stays until `demo/env/demo-env rm <id>`.
