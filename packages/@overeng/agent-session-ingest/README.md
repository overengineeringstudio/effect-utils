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

## Current adapters

- `codex`

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

Today, only `codex` currently meets that bar.

## Why only Codex today

Codex sessions are currently the strongest verified source-of-truth input for this package:

- append-only JSONL artifacts
- execution-rich records (`response_item`, `function_call`, `function_call_output`, `turn_context`, `event_msg`)
- straightforward incremental tailing semantics

Claude and OpenCode are intentionally not included yet.

### Claude

The currently observed local artifacts are not a strong source-of-truth execution log:

- `~/.claude/history.jsonl` is prompt history
- `~/.claude/tasks/*/*.json` are task records
- `~/.claude/debug/*.txt` is useful debugging output, but it is noisy and not a stable execution schema
- `~/.claude/session-env/*` currently does not look like a session transcript source

That means a faithful 1:1 adapter is not obvious yet. We likely need a different Claude artifact source before adding support here.

### OpenCode

The currently observed `~/.local/share/opencode/storage/session/*.json` and `message/*.json` files look metadata-heavy:

- session metadata
- message metadata
- finish reasons
- token/cost accounting

They do not yet look like a reliable execution-rich source-of-truth artifact for incremental ingestion. We should first identify the real tool/event transcript source before adding an adapter.

## Adapter criteria

An adapter belongs in this package only when the source provides:

1. a stable source-of-truth artifact format
2. enough execution detail to justify 1:1 schemas
3. incremental ingestion semantics that are reliable enough for checkpointed processing

If a source is primarily metadata, summaries, or debug text, it should stay out of this package until we identify a better underlying artifact.

## Usage

```ts
import { Effect } from 'effect'
import { FileCheckpointStore, ingestSource, makeCodexAdapter } from '@overeng/agent-session-ingest'

const program = Effect.gen(function* () {
  const adapter = makeCodexAdapter({
    sessionsRoot: '/path/to/codex/sessions',
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
