# notion md — Screenplay

Gap: Notion has no local Markdown source of truth — you can't edit pages in your editor, diff them, or let two-way edits meet safely. Wow: start one watcher, then every save round-trips live to Notion — and when both sides edit the same line it writes a conflict file instead of clobbering. ~7 min.

## Backstage (before recording — not on camera)

- `devenv shell`
- `eval "$(demo/env/demo-env new --export)"`   # fresh isolated env: sets DEMO_* + prints links
- Open the printed **md · Launch roadmap** + **md · API spec** links in the browser, side by side with the terminal.

Layout: terminal + editor on the left, the two Notion pages on the right.

## On camera (copy-paste in order)

### Beat 0 — Start the watcher   say: "One command. It watches two local files and keeps them in sync with Notion — no push, no pull, direction lives in each file."

```
cd "$DEMO_MD_DIR"
```

```
notion md sync --watch roadmap.nmd spec.nmd --poll-interval-ms 3000
```

### Beat 1 — Local edit → Notion (source: shared)   say: "I check a box in my editor and save — watch pushes it straight to the Notion page."

In your editor, open `roadmap.nmd` and check the first box, then save:

```text
- [ ] Finalize the API spec      →      - [x] Finalize the API spec
```

Watch prints `shared-merged`; the roadmap page updates in the browser.

### Beat 2 — Notion edit → local (source: remote)   say: "spec.nmd mirrors a page my team authors in Notion. I add an endpoint in Notion — a few seconds later it lands in my repo."

In the browser, on the **API spec** page, add a bullet under the list:

```text
- DELETE /v1/pages
```

Within ~1–2 poll cycles watch prints `pulled`; `spec.nmd` now shows the new endpoint locally.

### Beat 3 — Both sides edit the same line → guarded merge   say: "Now the scary case: my teammate and I edit the same line at once. Watch it refuse to clobber."

Stop the watcher, then diverge the same line on both sides:

```keys
# in the terminal
Ctrl-C
```

- In the browser, on the **Launch roadmap** page, change `On track for the Q3 release.` to `Slipping — blocked on review.`
- In your editor, change the same line in `roadmap.nmd` to `Ready to ship today.` and save.

```
notion md sync roadmap.nmd
```

It prints `shared-conflict` and writes `roadmap.nmd.conflict.roughdraft.md`. Open it — Base / Local / Remote side by side. Notion was **not** overwritten.

```
cat roadmap.nmd.conflict.roughdraft.md
```

### Bonus (if time) — Auto-merge non-overlapping edits   say: "Different lines? It just merges — no conflict."

Restart the watcher, edit a *different* line in Notion and a *different* line locally → watch prints `shared-merged` and both changes coexist.

```
notion md sync --watch roadmap.nmd spec.nmd --poll-interval-ms 3000
```
