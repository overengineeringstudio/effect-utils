# Chat uses OpenAI Chat Completions

## Decision

Use the OpenAI Chat Completions wire for chat across model families, with provider-prefixed IDs selected by the gateway. A gateway speaking this wire can also serve non-Effect clients.

## Rationale

A provider-native wire is not a single interoperable contract across model families. In the observed provider comparison, the official Anthropic integration could not consume gateway request/error/usage shapes, while `@effect/ai-openai-compat` handled text and streaming across the tested model families. This is a compatibility choice, not a claim that every model supports every schema.

## Consequences

Chat uses `/v1/chat/completions`; decision requests use their separate endpoint. Structured output requires gateway support for `response_format` and explicit failure when constraints cannot be honored.
