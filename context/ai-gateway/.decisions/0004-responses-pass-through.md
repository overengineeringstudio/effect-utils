# Decision 0004: Protected Responses pass-through with caller-carried state

Status: accepted

## Context

[Decision 0001](./0001-chat-completions-wire.md) selects Chat Completions for the shared Effect and Rust generation APIs. That choice does not establish that a chat-only comparison measures every model's native reasoning behavior. Responses has a different item model, reasoning controls, and encrypted reasoning continuity; translating it to chat can discard capabilities or change the workload. Chat-only evaluation can therefore favor models whose native interaction maps closely to Chat Completions. A comparison must record the endpoint, reasoning settings, continuation method, usage, and output constraints rather than attribute every difference to model quality.

The edge authenticates distinct consumers but forwards to a shared upstream account. An upstream response or conversation ID is not proof that the current consumer owns that state. `store: false` is not an authorization check on references supplied in later requests. Forwarding ID-based continuity without ownership enforcement would cross that boundary.

## Evidence and Argument

The [official OpenAI Responses reference](https://developers.openai.com/api/reference/resources/responses.md) defines:

- JSON `usage.input_tokens` and `usage.output_tokens`, with `input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens`.
- Terminal streaming event types `response.completed`, `response.incomplete`, and `response.failed`, each carrying a `response` object; usage observation reads that object's `usage` when supplied.
- `include: ["reasoning.encrypted_content"]` for carrying encrypted reasoning items between stateless requests, including with `store: false`.
- `previous_response_id`, `conversation`, and input item references as upstream-managed state mechanisms, distinct from complete caller-carried input items.

The reference's Markdown representation was read to verify these shapes. These are protocol definitions, not a claim that every upstream model supports every Responses feature. Usage can be absent or null; no token measurement can be inferred from its absence.

## Alternatives

| Alternative | Reasoning comparisons | State boundary and operational consequence |
| ----------- | --------------------- | ------------------------------------------ |
| Keep chat-only exposure | Retains one portable generation API but cannot exercise Responses-native reasoning/continuity; comparisons may reflect transport limitations. | Smallest edge surface; does not meet the need for native Responses requests. |
| Translate Responses into Chat Completions | Appears uniform but can alter reasoning controls, tool items, encrypted continuity, and reported usage. | Requires a semantic translation layer and makes faithful comparisons harder to interpret. |
| Protected Responses pass-through with caller-carried state (selected) | Preserves the requested Responses wire and supplied reasoning usage without claiming chat/Responses equivalence. | Uses existing edge authentication and accounting; rejects upstream state references rather than treating account access as consumer ownership. |
| Bind upstream response/conversation IDs to consumers | Could support ID-based reasoning continuity without discarding native features. | Requires durable consumer-to-ID ownership state, complete reference validation, lifecycle/retention policy, and retrieval authorization; this is not a stateless pass-through route. |
| Expose all Responses and conversation routes without ID binding | Preserves the full upstream workflow. | Lets shared-account identifiers bypass consumer isolation; rejected. |

## Decision

Add protected `POST /v1/responses` to the edge only. Reuse digest authentication, credential stripping, bounded request reading, upstream status/response-byte preservation, and cancellation. Do not add Effect or Rust Responses client APIs, translate to chat, or expose stored-response retrieval or conversation routes.

Never mutate an accepted Responses request body. In particular, do not force `store`, insert usage options, or apply Chat Completions' `stream_options.include_usage` rewrite. Reject non-null `previous_response_id`, any `conversation` field (even null), and any input-array item with `type: "item_reference"` before forwarding, with a clear 400 `gateway_error` and null `code`.

Support caller-carried continuity: callers can send `store: false`, request `include: ["reasoning.encrypted_content"]`, and echo complete prior items into the next `input`. Relevant item forms are `message`, `reasoning` with `encrypted_content`, `function_call`, and `function_call_output`. The edge does not decrypt, regenerate, or normalize these items. Encrypted items are caller-provided content, not an edge-managed ownership database.

Observe Responses JSON `usage` and terminal SSE `response.usage` under `response.completed`, `response.incomplete`, or `response.failed`. Account terminal streaming usage exactly once per request, without counting lifecycle snapshots or duplicate terminal events. Map input/output/cached/reasoning fields directly to the existing token kinds. Count only supplied nonnegative safe integers; missing or malformed values produce no corresponding token metric, while explicit zero is retained. Do not change SSE framing or convert failed/incomplete events into successful content.

Keep the global request-body default at 1 MiB. Allow an optional positive `routeMaxRequestBodyBytes["/v1/responses"]` configuration override; absence retains the global cap. A route-specific limit accommodates caller-carried context without increasing every protected route's allowance. Capacity planning can start at roughly four bytes per context token, then add encrypted reasoning and JSON escaping/structure overhead; this approximation is not a measured payload size or a safe universal bound. The configured limit applies to both declared Content-Length and incremental raw-byte consumption.

Keep conformance cases data-only as selected in [Decision 0003](./0003-data-only-conformance-cases.md). The edge replays the Responses cases; each language-client replay names them explicitly as inapplicable because no Responses client operation exists.

## Consequences

- Existing chat and native-decision contracts remain unchanged. Responses availability depends on upstream/model support, with upstream errors preserved rather than normalized into chat responses.
- Native reasoning comparisons become possible without asserting that endpoint choice, reasoning effort, token accounting, or continuation semantics are equivalent across models. Report these controls alongside results; reasoning token counts are not a quality score.
- Caller-carried history and encrypted reasoning increase request bytes. Deployers can size the Responses route independently while retaining bounded reads and the existing default elsewhere.
- Consumers cannot use upstream-managed response/conversation references through this edge. Full ID-based continuity requires a separate ownership-aware design, not a forwarding exception.
- No additional prompt, encrypted reasoning payload, credentials, or provider cost enters metric labels. Responses usage shares the existing bounded consumer/model accounting.
