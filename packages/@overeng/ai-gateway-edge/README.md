# @overeng/ai-gateway-edge

Authentication, forwarding and token accounting for the [shared AI gateway wire](../../../context/ai-gateway/spec.md). The [edge VRS](../../../context/ai-gateway/03-edge/spec.md) specifies its server-side guarantees. Provider credentials, deployment and application validation are not part of this package.

## Run

```sh
bun packages/@overeng/ai-gateway-edge/src/cli.ts serve \
  --config ./gateway.json --bind localhost:8080 --metrics-bind localhost:9090
printf '%s' "$CONSUMER_TOKEN" | bun packages/@overeng/ai-gateway-edge/src/cli.ts hash-token
```

The ports above are illustrative. All listener addresses and the upstream are runtime inputs. JSON configuration contains no bearer plaintext:

```json
{
  "upstream": "https://upstream.example",
  "consumers": [
    { "name": "example-consumer", "tokenSha256": "<64 lowercase hexadecimal digits>" }
  ]
}
```

Names and verifier digests must each be unique. Removing a verifier and restarting revokes only that consumer. The edge never forwards consumer Authorization to the upstream. Deployment must protect the optional metrics listener; it has no consumer auth.

`maxModelLabels` is an optional nonnegative integer, defaulting to 64. Request, duration and token metrics retain model labels only for upstream 2xx responses, admit at most this many distinct values, and aggregate further models as `_other`. All non-2xx responses use `_rejected` without consuming the cap. Forwarded model IDs are never rewritten. Set the cap to zero to aggregate all successful models.

## Compose

```ts
import { GatewayConfig, makeRoutes } from '@overeng/ai-gateway-edge'
import { Schema } from 'effect'

const config = Schema.decodeUnknownSync(GatewayConfig)({
  upstream: 'https://upstream.example',
  consumers: [],
})
const { router, metrics } = makeRoutes(config)
// Provide router to HttpRouter.serve with a NodeHttpServer layer.
// metrics.render() is Prometheus text exposition.
```

The empty table denies all protected operations. Model discovery, chat, structured output, tools and native decision responses pass through without semantic rewriting. Streaming chat forces `include_usage: true` and preserves SSE bytes. Provider usage is counted without inventing missing counts. Local errors have the shared error envelope; upstream errors retain their status and body.

## Conformance

The integration suite loads all 16 shared data-only conformance cases and replays their edge transport projections through a real edge against a fake upstream. `chat.stream.usage` and `decision.invalid-label` use unauthenticated client fake transports: their no-bearer success is not applicable to a protected edge, so replay supplies a fixture bearer. Original-schema validation in `structured.invalid` and label validation in `decision.invalid-label` belong to clients; the edge forwards those invalid outputs unchanged. No case is silently skipped. Edge-specific coverage includes config decoding, bearer revocation isolation, credential/header stripping, malformed requests, usage forcing, plaintext and transport errors, per-consumer metrics, incremental SSE delivery and upstream cancellation on client disconnect.

Published package declarations, tests, workspace membership and cache product registration use the repository's Genie/Buck conventions. The executable source and published CLI require Bun; no host-specific Nix module or provider fork pin is included.
