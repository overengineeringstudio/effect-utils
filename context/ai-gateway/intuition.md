# AI Gateway — Intuition

_For: application and client-library authors · Assumes: HTTP and JSON · Covers: the shared contract and its realizations_

```text
consumers
    |
    v
client realizations
    +-- 01-effect: Effect AI layers
    +-- 02-rust: async Rust client
    |
    v
public wire: models + chat/SSE + native decisions
    |
    v
03-edge: public authentication, forwarding, and per-consumer accounting
    |
    v
provider access and credential custody
```

A client chooses an advertised model ID and presents a consumer bearer. It does
not need a provider credential or knowledge of where the gateway runs. Replacing
the gateway's credential backend changes the last box, not the program contract.

Chat and native decisions are separate operations. Chat can generate a label,
but that does not make its confidence a calibrated decision probability.
Likewise, asking for JSON is not the same as receiving a valid structured value:
the client checks the original schema even when provider strictness is relaxed.

Streaming changes when output arrives, not what counts as success. Usage can
arrive in a final chunk with no choices, and an error can arrive after HTTP 200.
The client keeps its operation span open until the stream finishes or fails.
