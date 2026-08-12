# Buck2 adoption benchmark

This harness measures the current Devenv/Nix task path and an explicitly named
Buck2 target side by side at one immutable Git revision. It does not calculate
or assert a cross-engine winner. It defaults to a dry run and, when executed,
creates a detached scratch worktree so compiler cleanup and controlled source
mutations cannot alter the invoking worktree.

It records raw samples and aggregate summaries as JSONL. Every run records the
exact Git SHA, tool versions, a non-sensitive host class, initial/final cache
sizes and file counts, per-sample cache treatment, command-output hashes,
action/materialization counts when Buck exposes them, and explicit
`skipped`/`no-verdict` records when a tool, target, mutation path, or
prerequisite is unavailable. Cache directory scans stay outside measured
phases so they do not warm every input tree before each sample.

The harness never drops filesystem page caches, runs Nix GC, prunes a pnpm
store, or claims that a fresh worktree is a cold Nix store. The first Devenv
phase is named `profile-cold-store-warm` for that reason.

## Preview

```text
immutable SHA
  |
  +-- Devenv end-user path
  |     +-- profile-cold/store-warm
  |     `-- warm no-op
  |
  +-- Devenv compute-only path
  |     +-- compiler-clean/cold
  |     +-- warm no-op
  |     `-- mtime / relevant / irrelevant mutations
  |
  `-- Buck2 local-only, remote-cache disabled
        +-- clean action cache
        +-- warm no-op
        +-- daemon restart with cache retained
        `-- mtime / relevant / irrelevant mutations
```

## Usage

Preview the complete matrix without running builds:

```bash
node scripts/buck2-benchmark/benchmark.mjs \
  --output tmp/buck2-benchmark/dry-run.jsonl
```

Run it after the Buck target and pinned binary exist:

```bash
node scripts/buck2-benchmark/benchmark.mjs \
  --execute \
  --buck-bin /path/to/pinned/buck2 \
  --buck-target //:check \
  --work-contract workspace-typecheck/v1 \
  --runs 7 \
  --warmups 2 \
  --output tmp/buck2-benchmark/local.jsonl
```

Use `--buck-incremental-only` for a non-comparative watcher/invalidation run.
It skips Devenv plus Buck's destructive cold and daemon-restart phases, prepares
one unmeasured Buck baseline, and measures the warm and mutation phases.

`--in-place` is available for debugging but requires a clean worktree. The
detached scratch worktree is the benchmark default. `--keep-worktree` retains
it for inspection and records that cleanup was intentionally incomplete.

The default relevant mutation is
`packages/@overeng/tui-core/src/mod.ts`; the default irrelevant mutation is a
Markdown file outside the TypeScript graph. Override both paths when a narrower
Buck target has a different dependency boundary.

Execution has no default Buck target. `--buck-target` and `--work-contract`
are both mandatory: the ID names the reviewed relationship between the Buck
target and the fixed Devenv `ts:check` paths. A contract does not imply
equivalence. `--declare-equivalent-work` is a separate explicit assertion and
remains off when no equivalent Devenv lane exists. The harness records such an
assertion as operator-supplied, not independently verified. Per-engine summaries always carry
`crossEngineComparison.generated: false` and a no-verdict reason; producing a
comparative conclusion requires separate equivalence evidence and review.

Run the pure parser and aggregation tests without installing dependencies:

```bash
node --test \
  scripts/buck2-benchmark/lib.unit.test.mjs \
  scripts/buck2-benchmark/evidence-integrity.unit.test.mjs \
  scripts/buck2-benchmark/dry-run.integration.test.mjs
```

That gate also pins the exact SHA-256 digests of the two committed `tui-core`
summary snapshots. They are immutable experiment evidence rather than outputs
to regenerate in place; a new measurement should add a new reviewed snapshot
and update the adjacent experiment record.

Re-summarize an existing raw record:

```bash
node scripts/buck2-benchmark/summarize.mjs \
  tmp/buck2-benchmark/local.jsonl \
  tmp/buck2-benchmark/local.summary.jsonl
```

## Interpretation constraints

- `end-user` and `compute-only` are distinct scopes. Mixing them attributes
  pnpm, Genie, and Devenv task evaluation to the compiler. Even within one
  scope, do not compare engines unless the named work contract is current.
- `action-cold` means an empty Buck isolation directory with local execution;
  it does not mean cold filesystem pages or an empty Nix store.
- A failed `buck2 clean` or `buck2 kill` control yields a skipped/no-verdict
  sample. The harness never labels an uncontrolled run cold or daemon-restarted.
- `--no-remote-cache --local-only` isolates local graph/action behavior. Remote
  cache benchmarking is a separate experiment and should use a new isolation
  directory and explicit remote-cache provenance.
- A Buck action that shells back into `devenv tasks run ts:check` or consumes
  ambient undeclared `node_modules` is only launcher-overhead evidence. It is
  not evidence of hermetic cache keys or cross-worktree reuse.
- A successful command with unavailable Buck event-log parsing retains the
  timing but records `buckLogStatus: unavailable`; action-count conclusions
  then remain no-verdict.
