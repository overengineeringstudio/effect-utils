# Compose official Effect providers instead of writing one

## Decision

Expose thin layers over `@effect/ai-openai-compat` for chat and `@effect/ai-typesafe` for decisions. Do not maintain a custom Effect provider or response-rewriting client.

## Rationale

The provider comparison showed that the official Anthropic provider was incompatible with the gateway's request and error/usage shapes, while the OpenAI-compatible provider handled the tested chat routes. Composing the working official providers keeps the schema, error, and transport behavior in Effect AI rather than duplicating it locally.

## Consequences

The wrapper owns endpoint assembly, redacted token configuration, and model selection. The gateway remains responsible for wire compatibility; an unsupported feature fails rather than being silently emulated.
