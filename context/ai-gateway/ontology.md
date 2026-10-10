# AI Gateway — Ontology

## Language

- **Consumer:** A program authorized to make gateway requests independently of other programs.
- **Consumer token:** A revocable bearer identifying one consumer at the gateway boundary, not a provider credential.
- **Gateway:** A service exposing the shared model, chat, and native decision wire while adapting provider access.
- **Gateway origin:** The base URL before the `/v1` API path.
- **Client realization:** A language-specific integration refining the shared consumer contract.
- **Gateway realization:** An implementation of the public wire whose deployment and credential custody are outside this tree.
- **Provider-prefixed model ID:** A gateway-advertised identifier whose prefix distinguishes a provider or access route; consumers treat the whole ID as opaque.
- **Chat model:** A model accessed through Chat Completions, including tool-call messages.
- **Original schema:** The caller's complete validation schema, before provider projection or gateway adaptation.
- **Structured output:** A requested structured answer accepted only after validation against the original schema.
- **Decision model:** A native model evaluating named classification, probability, or rating questions against encoded input.
- **Probability:** A native decision provider's likelihood for an answer or option, not a number inferred from chat text.
- **Confidence:** Provider-reported confidence in a decision answer, distinct from an option's probability.
- **Usage:** Provider-reported token consumption; absent usage is unknown rather than a measured zero.

## Structure

```text
consumer -> client realization -> public wire -> gateway realization -> providers
               |                       |
        original-schema checks   per-consumer bearer boundary
        client GenAI spans       native decision / chat distinction
```

Client realizations refine one contract rather than defining separate gateways.
Model identity and consumer identity are independent: a bearer identifies access,
not an account selector or proof of model availability.
