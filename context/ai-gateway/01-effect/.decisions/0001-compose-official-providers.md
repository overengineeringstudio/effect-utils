# Decision 0001: Compose official Effect providers

Status: accepted

## Context

The Effect realization needs chat and native decisions without maintaining a
second provider implementation or response-rewriting client.

## Evidence and Argument

The provider comparison found the official Anthropic integration incompatible
with gateway request/error/usage shapes, while the OpenAI-compatible provider
handled the tested chat routes. Official provider composition keeps schema,
error, and transport behavior in Effect AI rather than duplicating it locally.

## Options

| Option | Tradeoff |
| --- | --- |
| Official compatible and TypeSafe providers (selected) | Thin wrapper; upstream owns decoding and validation contracts. |
| Custom Effect provider | Duplicates provider schemas, errors, streaming, and transport maintenance. |
| Native-provider wrapper | Cannot consume this gateway's shared chat wire reliably. |

## Decision

Expose thin layers over `@effect/ai-openai-compat` for chat and
`@effect/ai-typesafe` for native decisions, following the
[parent wire](../../spec.md).

## Consequences

The wrapper owns endpoint assembly, redacted token configuration, and model
selection. Unsupported features fail rather than being silently emulated.
[The Effect specification](../spec.md) owns the realization.
