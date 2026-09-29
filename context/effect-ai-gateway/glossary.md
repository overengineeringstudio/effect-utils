# Effect AI Gateway — Glossary

## Language

- **Gateway:** A service exposing the compatible model and decision endpoints while routing requests to subscription-backed models.
- **Gateway origin:** Base URL before the `/v1` API path.
- **Provider-prefixed model ID:** Gateway-advertised model identifier whose prefix distinguishes the model's provider or access route.
- **Chat model:** A language model accessed through the Chat Completions wire contract.
- **Structured output:** An answer requested and checked against a declared schema.
- **Decision model:** A model producing typed classification, probability, or rating answers for declared questions and encoded input.
- **Confidence:** Provider-reported confidence in a decision answer, distinct from an option's probability.
