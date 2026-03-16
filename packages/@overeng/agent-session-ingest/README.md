# @overeng/agent-session-ingest

Reusable Effect primitives for incrementally ingesting coding-agent session artifacts.

## Overview

`@overeng/agent-session-ingest` provides the deterministic ingestion layer for
native coding-agent session stores. It is designed for consumers that need to
process large local session histories incrementally without re-reading every
artifact on every run.

The package owns:

- source-specific 1:1 decoding
- append-only and mutable artifact readers
- checkpoint persistence
- incremental reprocessing

It does not own higher-level analysis such as:

- friction detection
- finding synthesis
- AI prompting
- issue tracking integration

## Adapters

- `codex` via native rollout/session `jsonl`
- `claude` via native project/subagent `jsonl`
- `opencode` via native SQLite state

## Source strategy

### Codex

- Discovery can optionally use SQLite state or filesystem scanning.
- Canonical transcript ingestion uses rollout/session `jsonl`.
- This preserves the append-only event stream directly.
- References:
  - [Codex adapter](./src/adapters/codex.ts)
  - [Codex transcript schema](./src/adapters/codex.ts)

### Claude

- Canonical transcript ingestion uses project/subagent `jsonl` under
  `~/.claude/projects`.
- On this machine that path is a symlink to `~/.claude-shared/projects`.
- `history.jsonl`, `tasks`, `todos`, and `debug` are ancillary and are not the
  primary adapter source.
- References:
  - [Claude adapter](./src/adapters/claude.ts)
  - [Claude transcript schema](./src/adapters/claude.ts)

### OpenCode

- Canonical transcript ingestion uses the local SQLite database at `~/.local/share/opencode/opencode.db`.
- Rich structured records live in the `session`, `message`, and `part` tables.
- `opencode export` is useful as a debugging and verification oracle, but it is
  not the primary adapter source.
- References:
  - [OpenCode adapter](./src/adapters/opencode.ts)
  - [OpenCode record schema](./src/adapters/opencode.ts)

## Package boundary

This package expects adapters to model the underlying source faithfully. Each
adapter should use 1:1 Effect schemas over the provider's native record format
before any downstream normalization happens.

This package is a good fit for:

- discovering native session artifacts
- decoding provider-native records
- reading only new or changed content
- persisting ingestion checkpoints

This package is not a good fit for:

- provider-agnostic semantic event modeling
- clustering or ranking issues
- AI synthesis over session history

## Core model

The core data flow is:

```text
artifact discovery
  -> provider-native record decode
  -> checkpoint-aware ingest
  -> consumer-specific normalization or analysis
```

The package supports two main artifact shapes:

- append-only text artifacts such as `jsonl`
- mutable artifacts such as SQLite-backed stores

## Usage

Example using the Claude adapter and a file-backed checkpoint store:

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

## Choosing a source

Prefer the most faithful native source that the provider exposes:

1. native transcript/event files
2. native structured state stores
3. discovery indexes only when they point to a richer transcript source

Avoid building adapters over debug logs, prompt history, or weak metadata if a
better native source exists.

## Validation

Each adapter should be verified in two ways:

- fixture-backed integration tests for discovery and incremental ingestion
- live local smoke checks against the native source when available

Current adapter-specific integration coverage lives in:

- [Codex integration test](./src/codex.integration.test.ts)
- [Claude integration test](./src/claude.integration.test.ts)
- [OpenCode integration test](./src/opencode.integration.test.ts)

## Layering

The intended layering is:

```text
source artifact
  -> source-specific 1:1 schema
  -> shared incremental ingestion + checkpoints
  -> consumer-specific normalization / analysis
```

Consumers should build their own domain abstractions on top of this package
instead of pushing source-specific or AI-specific logic down into the ingestion
layer.
