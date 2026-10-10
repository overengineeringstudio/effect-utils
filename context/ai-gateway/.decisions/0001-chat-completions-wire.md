# Decision 0001: Chat uses OpenAI Chat Completions

Status: accepted

## Context

Programs need one generation wire across provider families and client languages.

## Evidence and Argument

The provider comparison found incompatible native request/error/usage shapes
while the OpenAI-compatible route handled text and streaming across the tested
model families. This is an interoperability choice, not a guarantee that every
model supports every schema.

## Options

| Option | Tradeoff |
| --- | --- |
| Chat Completions (selected) | Shared client ecosystem and a stable cross-provider wire; gateway translation is required for native-only backends. |
| Provider-native endpoints | Couple consumers to provider families and expose incompatible request/SSE shapes. |
| Gateway-private streams | Couple consumers to one gateway implementation's releases. |

## Decision

Use OpenAI Chat Completions for chat across model families and languages.
Provider-prefixed model IDs are selected from the gateway catalog and preserved
unchanged. Native decisions retain their separate operation.

## Consequences

Chat uses `/v1/chat/completions`; decision requests use their separate endpoint. Structured output requires gateway support for `response_format` and explicit failure when constraints cannot be honored.
