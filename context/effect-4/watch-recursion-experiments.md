# Watch Recursion Experiments — Effect v4 `FileSystem.watch`

Study of the effect@4.0.0-rc.111 watch API and its three in-repo consumers
(`@overeng/megarepo`, `@overeng/genie`, `@overeng/notion-md`), evaluating two
migration strategies under the locked "embrace always-recursive watch" decision:

- **(a) filter-helper** — a shared helper filters the recursive event stream down to each consumer's old non-recursive scope.
- **(b) embrace-recursion-with-coalescing** — restructure each consumer to consume the full recursive stream, with per-consumer coalescing/dedup.

All claims carry file:line evidence. Empirical probes were run on this workstation (NixOS, Node v24.20.0-ish per system node; see §2).

---

## 1. Pinned semantics of `FileSystem.watch` at rc.111

Interface (`node_modules/.pnpm/effect@4.0.0-rc.111/node_modules/effect/src/FileSystem.ts`, cited as `FileSystem.ts` below):

| Fact | Evidence |
|---|---|
| `watch(path, options?) => Stream<WatchEvent, PlatformError>` | FileSystem.ts:361 |
| Doc: *"By default, only changes to the direct children of the directory are reported. Set the `recursive` option to `true`…"* | FileSystem.ts:353–360 |
| `WatchOptions { readonly recursive?: boolean \| undefined }` — **recursion is opt-in, not forced** | FileSystem.ts:1171–1176 |
| `WatchEvent = Create \| Update \| Remove`; every variant carries only `_tag` + `path` | FileSystem.ts:1196, 1216, 1232, 1248 |
| Escape hatch: `WatchBackend.register(path, stat, options)` can replace the platform stream entirely | FileSystem.ts:1293–1299 |

Node backend (`@effect/platform-node-shared/src/NodeFileSystem.ts`, cited as `NodeFileSystem.ts`):

| Fact | Evidence |
|---|---|
| Node impl forwards `recursive: options?.recursive ?? false` straight into `fs.watch` | NodeFileSystem.ts:557–558 |
| `"rename"` → re-`stat`s the path: exists ⇒ `{_tag:"Create"}`, gone ⇒ `{_tag:"Remove"}` | NodeFileSystem.ts:562–567 |
| `"change"` → `{_tag:"Update"}` (offered unsafely, no backpressure) | NodeFileSystem.ts:569–571 |
| Backend error fails the stream (`Unknown` system error); watcher close ends it | NodeFileSystem.ts:575–593 |
| Stream is built via `stat(path)` first, then either custom backend or `watchNode` | NodeFileSystem.ts:598–608 |
| Wired into the service as `watch(path, options)` with optional `WatchBackend` from context | NodeFileSystem.ts:659–661 |

### Key correction to the working assumption

The premise "v4 `FileSystem.watch` is always-recursive" is **not what rc.111 ships**.
Recursion remains opt-in via `WatchOptions.recursive` (FileSystem.ts:1171–1176), and the
Node layer explicitly defaults it to `false` (NodeFileSystem.ts:558). The interface docs
still describe direct-children-only as the default (FileSystem.ts:353–360).
Nothing else in `effect/src` defines another watch API (only `src/FileSystem.ts`
mentions `WatchOptions`/`WatchEvent`). Any migration step that assumes forced recursion
must instead pass `{ recursive: true }` explicitly at each call site.

### Event-shape consequences that matter regardless of the recursive flag

1. **Paths are reported relative to the watched root** (raw node `fs.watch` contract,
   passed through verbatim at NodeFileSystem.ts:557–560). Every consumer must
   `resolve(watchRoot, event.path)` before comparing — all three call sites already do.
2. **No debouncing/coalescing primitives exist anywhere in the API.** The event is
   delivered 1:1 into the stream; there is no batch window, no `WatchEvent` kind for
   "many changes", and no dedup key beyond `(path, _tag)`. Coalescing is entirely the
   consumer's job (see §3/§4 — notion-md already rolls its own; genie has none).
3. **Tag fidelity is weak on Linux**: writes frequently surface as `"rename"` (which
   becomes `Create` after a successful stat) rather than `"change"` → `Update`. No
   consumer may assume `Update` is the only modification tag.

---

## 2. Empirical probes (this workstation)

Scripted against raw `fs.watch` (the exact substrate of `watchNode`,
NodeFileSystem.ts:557):

1. **Recursive watch works on Linux here.** Watching a temp root with
   `{recursive:true}` delivered an event for a file created two levels deep
   (`EVENT rename nested/deep/f.txt`). Older "unsupported on Linux" behavior does not
   apply to this Node build.
2. **Heavy native coalescing under burst**: five sequential `writeFileSync` calls to one
   nested file produced a *single* `rename` event; a top-level write, a `mkdir`, and a
   create inside the new dir produced exactly one event each:
   `["rename:nested/f.txt", "rename:nested/sub", "rename:nested/sub/g.txt", "rename:top.txt"]`.
   So the "duplicate-event storm" risk is real but smaller than the classic chokidar-era
   folklore suggests on this platform — bursts collapse, but *per-save* duplicates across
   editor write+rename sequences still occur (probe 1 showed save-style rename chains).
3. **Non-recursive control**: a second watcher without `recursive` on the same root saw
   nothing for nested-path mutations — confirming today's consumers are blind to nested
   activity, and confirming recursion strictly enlarges the event set.
4. All events arrived with paths relative to the watched root, matching §1.

Implication: under recursion the dominant new cost is *volume* (events from arbitrary
subtree depth), while duplication within a burst is partly absorbed by the kernel/libuv
layer. Consumer-side debounce windows (250 ms-class) remain necessary and sufficient.

---

## 3. Consumer analyses

### 3.1 `@overeng/megarepo` — no watch usage

Grep over `packages/@overeng/megarepo/src` for `watch`/`FileSystem` finds no `fs.watch`
or `.watch(` call site. The only hits are a comment about avoiding `fs.watch` edge cases
for lock polling (`src/lib/store-lock.ts:109–110`) and prose docs
(`docs/integrations/bun.md:104–111`, `docs/integrations/typescript.md:119–136` — both
about external tools' watch modes).

**Impact: none. Nothing to migrate.** If megarepo ever grows a watcher (e.g., live
re-compose on member ref changes), it should start on strategy (b) directly.

### 3.2 `@overeng/genie` — watch-mode regeneration (`src/build/mod.tsx`)

Current usage (all in the CLI handler, watch branch `mod.tsx:199–289`):

- Watches the resolved working directory: `fs.watch(resolvedCwd)` — `mod.tsx:202`. **No
  options object ⇒ non-recursive today** (§1).
- Filter: `Stream.filter(({path}) => p.endsWith('.genie.ts'))` — `mod.tsx:203`.
  Suffix-only, path-relative, no tag check, no debounce.
- Per event: TUI `WatchReset` (`mod.tsx:208`), **full re-discovery**
  `findGenieFiles(resolvedCwd)` (`mod.tsx:212`), regenerate the changed file
  (`generateFile`, `mod.tsx:222–226`), mark others unchanged, dispatch summary
  (`mod.tsx:246–286`), drained by `Stream.runDrain` (`mod.tsx:288`).
- **No coalescing/debounce whatsoever** — one event = one full cycle.
- Discovery itself *is* recursive: `findGenieFiles` walks the tree manually with symlink
  handling and a seen-directory set (`src/core/discovery.ts:154–200`).

What breaks / changes under always-recursive:

- **Correctness gap actually closes.** Today discovery finds nested `*.genie.ts` files
  but the non-recursive watcher never fires for them: editing
  `members/foo/x.genie.ts` regenerates nothing in watch mode. Recursive watch fixes a
  latent bug for free.
- New failure mode: volume + churn. Every nested change matching the suffix triggers a
  full `findGenieFiles` walk plus generation; rapid multi-file saves queue many
  sequential cycles (the stream is pulled sequentially by `runDrain`), each resetting the
  TUI (`WatchReset`) — visible flicker and wasted walks, but no concurrent-generation
  race because consumption is serialized.
- Edge: a created *directory* named `*.genie.ts` passes the suffix filter; harmless today,
  equally harmless recursive, worth a stat-guard only if free.

Strategy verdict:

| | (a) filter-helper | (b) embrace-recursion-with-coalescing |
|---|---|---|
| Correctness | Keeps the nested-file blindness bug (helper restores old scope = old bug) | Fixes it; recursive scope matches recursive discovery |
| Code delta | ~zero (call helper instead of inline filter) | Moderate: wrap event flow in a debounce window; collect changed paths per window; run one regen pass over the batch |
| Perf | Same as today + wasted events filtered | Fewer redundant cycles than today once coalesced (one walk per window, not per event); more events ingested but suffix-filtered cheaply |

**Recommendation: (b)** — embrace recursion *with* a small coalescing window. This is the
only consumer where recursion changes observable behavior, and the change is an
improvement. Concretely: keep `fs.watch(resolvedCwd, {recursive:true})` (explicit flag,
§1), suffix-filter as now, accumulate changed paths for a 250 ms window, then run the
existing per-file pipeline once per window over the deduped set (reusing the existing
`Stream.tap` body, `mod.tsx:204–287`, driven from `Queue.sliding` + `takeAll` like
notion-md does). The TUI `WatchReset` moves inside the windowed pass so one burst renders
one cycle.

### 3.3 `@overeng/notion-md` — single-file watch (`src/cli-program.ts`)

Current usage (`runWatch`, `cli-program.ts:306–409`):

- Watches the *parent directory of the target file*: `watchedDir = dirname(path)`
  (`cli-program.ts:315`), `fs.watch(watchedDir)` (`cli-program.ts:359`) — non-recursive.
- Filter: exact absolute-path equality
  `resolve(watchedDir, event.path) === watchedPath` (`cli-program.ts:360`). This *is*
  strategy (a)'s scope filter, hand-rolled.
- Debounce/coalesce already present: sliding queue 1024 (`cli-program.ts:311`),
  initial event seeded (`cli-program.ts:358`, offered at startup alongside file/poll),
  loop takes one trigger, sleeps 250 ms, drains `takeAll`, runs one reconcile pass
  (`cli-program.ts:387–390`); reason chosen last-wins by `nextWatchReason`
  (`cli-program.ts:291–303`).
- Error path degrades to poll-reason triggers (`cli-program.ts:362–372`).
- Poll loop merges remote-change triggers every `pollIntervalMs`
  (`cli-program.ts:372–377`).

What breaks / changes under always-recursive:

- Functionally: **nothing**. The equality filter already rejects every event outside the
  single target path, at any depth. Extra recursive events are pure overhead flowing
  through a cheap string comparison.
- Volume: sibling subtrees under the watched dir (including `.notion-md/sync/*` sidecar
  writes, which live next to the `.nmd` tree — see the sidecar comment at
  `state-store.ts:219–225`) now reach the filter. Bounded noise; the 250 ms drain already
  collapses whatever survives.

Strategy verdict:

| | (a) filter-helper | (b) embrace-recursion-with-coalescing |
|---|---|---|
| Correctness | Identical to today | Identical (same filter, wider input) |
| Code delta | ~zero (swap inline filter for shared helper) | Zero-to-negative: there is no broader scope to embrace — the consumer's domain is exactly one file |
| Perf | Equal | Equal or marginally worse (more events through the filter) |

**Recommendation: (a)** — adopt the shared filter-helper (or leave as-is; it already
implements the pattern). Embracing recursion buys nothing when the desired scope is one
file. Only mechanical change if the migration forces it: pass `{recursive:true}`
explicitly and rely on the existing equality filter (`cli-program.ts:360`), which needs
no other edit thanks to the existing debounce loop.

### 3.4 `@overeng/notion-md` — batch watch (`src/batch.ts`)

Current usage (`runBatchWatch`, `batch.ts:459–556`):

- Resolves target set, builds `watchedPaths` Set + distinct parent dirs
  (`batch.ts:468–470`).
- **One `fs.watch(watchedDir)` per distinct parent dir**, forked scoped
  (`batch.ts:474–491`); filter = Set membership of the resolved path
  (`batch.ts:477`); per-event offers `{path, reason:'file'}` into a sliding queue 4096
  (`batch.ts:466`).
- Coalescing is the most mature of the three call sites: `WATCH_DEBOUNCE = 250ms`
  (`batch.ts:12`), main loop takes first trigger, sleeps, drains, then
  `coalesceTriggers` dedups by path keeping the highest-ranked reason
  (`batch.ts:418–434`, rank at `batch.ts:405–416`), and runs ONE batch sync over all
  triggered targets (`batch.ts:520–523`).
- Additional trigger sources merged in: poll interval (`batch.ts:496–501`) and webhook
  `triggerSource` stream (`batch.ts:503–512`).

What breaks / changes under always-recursive:

- Functionally: nothing — Set-membership filtering (`batch.ts:477`, also applied to
  webhook triggers at `batch.ts:507`) is depth-independent.
- Structural opportunity: N parent-dir watchers could collapse to **one recursive watch
  over the common ancestor**, cutting OS watcher count from N to 1 and deleting the
  per-dir fork loop (`batch.ts:474–491`) — the resolved-path Set keeps working unchanged
  since `resolve(root, relativeEventPath)` still yields absolute watched paths.
- Feedback loop note (pre-existing, unchanged): sync passes write `.nmd` files and
  sidecars inside the watched tree, re-triggering the next window; the debounce +
  coalesce pair bounds this to one extra pass per 250 ms window. Recursion adds
  sidecar-subtree events to the same bounded path.

Strategy verdict:

| | (a) filter-helper | (b) embrace-recursion-with-coalescing |
|---|---|---|
| Correctness | Identical | Identical (Set membership is scope-agnostic) |
| Code delta | Small: replace inline membership filter with helper | Moderate: single-root watch replaces per-dir fan-out; delete fork loop |
| Perf | N watchers, N streams, same filtering | 1 watcher, fewer syscalls/inodes; identical pass count thanks to existing coalesce |

**Recommendation: (b)** — this call site already has best-in-repo coalescing
(`coalesceTriggers`), so "embracing recursion" reduces to a watcher-count optimization:
one recursive watch over the deepest common ancestor of `paths`, feeding the existing
queue/filter/debounce machinery untouched. Keep the per-dir variant only if common-root
resolution proves fiddly; correctness is unaffected either way.

---

## 4. Strategy comparison — summary

| Consumer | Current scope | Breaks under recursion? | Recommended strategy | Rationale |
|---|---|---|---|---|
| `megarepo` | none | n/a | n/a (start on (b) if ever needed) | No call sites (`store-lock.ts:109–110` deliberately avoids fs.watch) |
| `genie` watch | cwd dir, non-recursive, no debounce (`build/mod.tsx:202–288`) | No breakage; fixes nested-file blindness | **(b)** with 250 ms coalescing window | Discovery already recursive (`core/discovery.ts:154`); coalescing removes today's per-event full-walk churn |
| `notion-md` runWatch | one parent dir, exact-path filter (`cli-program.ts:359–360`) | No | **(a)** filter-helper | Desired scope is one file; recursion adds only filtered noise |
| `notion-md` runBatchWatch | N parent dirs, Set filter (`batch.ts:474–477`) | No | **(b)** single recursive root watch | Existing coalesce (`batch.ts:12,418–434`) absorbs volume; collapses N watchers to 1 |

Cross-cutting risks table (both strategies):

| Risk | Mitigation grounded in code |
|---|---|
| Duplicate/burst events | Kernel-level coalescing observed (§2 probe 2) + consumer 250 ms windows already exist in notion-md (`batch.ts:12`, `cli-program.ts:388`); port the same window to genie |
| Tag misclassification (writes arriving as `Create` via rename→stat) | No consumer inspects `_tag` (genie `mod.tsx:203`, notion-md `cli-program.ts:360`, `batch.ts:477` all filter on path only) — keep it that way |
| Relative event paths | All three sites already resolve against the watch root before comparing |
| Watcher error mid-stream | notion-md degrades to polling (`cli-program.ts:362–372`); genie currently has no error handling on the watch stream (`mod.tsx:202–288`) — add catch→log when touching it |
| Self-trigger loops (tool writes what it watches) | Pre-existing and window-bounded in notion-md; genie's generated targets are read-only by default (docs/spec.md:70–72), so exposure is limited to user edits |

---

## 5. Shared helper worth extracting into `@overeng/utils`

Three call sites independently reimplement the same 15-line skeleton:
resolve event path against watch root → scope predicate → (optionally) debounce window →
dedup/coalesce. Extract one helper, e.g.:

```ts
// @overeng/utils proposal (shape only)
export const watchScoped = (opts: {
  readonly roots: ReadonlyArray<string>            // dirs to watch ({recursive:true} when roots.length===1 covers subtrees)
  readonly scope: ReadonlySet<string> | ((abs: string) => boolean)
  readonly debounce?: Duration.Duration             // default 250ms, matching WATCH_DEBOUNCE (batch.ts:12)
}): Stream.Stream<ReadonlyArray<{ path: string; events: WatchEvent[] }>, PlatformError>
```

- Emits **batches** of deduped absolute paths per window (what both notion-md loops and
  the proposed genie window consume), rather than raw events.
- Internalizes the resolve-and-compare idiom duplicated at `cli-program.ts:360`,
  `batch.ts:477`, and implicitly by genie's suffix filter (`mod.tsx:203`).
- Keeps `_tag` opaque in its output type so future backends can't break consumers via
  tag drift (§1 consequence 3).

Sequencing recommendation: land genie's windowed pass and the batch single-root watch
first (they define the helper's real requirements), extract `watchScoped` second, then
migrate `runWatch` onto it. Do not extract up-front — the prior attempt produced nothing;
two concrete migrations before one abstraction.

## 6. Open follow-ups

1. Confirm with upstream whether rc.111's opt-in `recursive` (§1) is intended to flip to
   default-on before 4.0 final; if yes, the explicit flags recommended here become
   no-ops, not hazards.
2. Genie: add watch-stream error handling symmetric to notion-md's
   (`cli-program.ts:362–372`) when implementing the windowed pass.
3. Measure `findGenieFiles` cost on a large workspace to size genie's debounce window
   (250 ms assumed by analogy with notion-md, not measured).
