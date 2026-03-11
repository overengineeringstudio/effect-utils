# @overeng/agent-session-ingest

Reusable Effect primitives for incrementally ingesting coding-agent session artifacts.

## Scope

This package owns only the deterministic ingestion layer:

- source-specific 1:1 decoding
- append-only and mutable artifact readers
- checkpoint persistence
- incremental reprocessing

It does **not** own higher-level janitor logic such as:

- friction detection
- finding synthesis
- Beads integration
- AI prompting

## Adapters

- `codex` via native rollout/session `JSONL`
- `claude` via native project/subagent `JSONL` under `~/.claude/projects -> ~/.claude-shared/projects`
- `opencode` via native SQLite state at `~/.local/share/opencode/opencode.db`

## Merge policy

This package is intended to provide first-class adapter parity for:

- `codex`
- `claude`
- `opencode`

The PR stays open until all three adapters meet the same bar:

- real source-of-truth artifact discovery
- faithful 1:1 Effect schemas
- incremental ingestion semantics
- replay/fixture coverage
- live local verification

Merge remains blocked until all three adapters are verified to the same quality bar in CI and with local smoke checks.

## Source strategy

### Codex

- Discovery can optionally use SQLite state/indexes.
- Canonical transcript ingestion uses rollout/session `JSONL`.
- This is the preferred source because it preserves the full append-only event stream.

### Claude

- Canonical transcript ingestion uses project/subagent `JSONL` under `~/.claude/projects`.
- On this machine that path is a symlink to `~/.claude-shared/projects`.
- `history.jsonl`, `tasks`, `todos`, and `debug` are ancillary and should not be used as the primary adapter source.

### OpenCode

- Canonical transcript ingestion uses the local SQLite database at `~/.local/share/opencode/opencode.db`.
- Rich structured records live in the `session`, `message`, and `part` tables.
- `opencode export` is still useful as a debugging and verification oracle, but it is not the primary adapter source.

## Adapter criteria

An adapter belongs in this package only when the source provides:

1. a stable native source-of-truth artifact format
2. enough execution detail to justify 1:1 schemas
3. incremental ingestion semantics that are reliable enough for checkpointed processing

If a source is primarily metadata, summaries, or debug text, it should stay out of this package until we identify a better underlying artifact.

## Usage

```ts
import { Effect } from 'effect'
import { FileCheckpointStore, ingestSource, makeClaudeAdapter } from '@overeng/agent-session-ingest'

const program = Effect.gen(function* () {
  const adapter = makeClaudeAdapter({
    projectsRoot: '/path/to/.claude-shared/projects',
  })

  return yield* ingestSource(adapter)
}).pipe(Effect.provide(FileCheckpointStore({ path: '/tmp/agent-session-checkpoints.jsonl' })))
```

## Design

The intended layering is:

```text
source artifact
  -> source-specific 1:1 schema
  -> shared incremental ingestion + checkpoints
  -> consumer-specific normalization / analysis
```

Consumers such as janitor should build their own shared abstraction on top of this package instead of pushing source-specific or AI-specific logic down into the ingestion layer.
