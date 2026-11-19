# @overeng/ai-gateway-edge

Authentication, forwarding and token accounting for the [shared AI gateway wire](../../../context/ai-gateway/spec.md). The [edge VRS](../../../context/ai-gateway/03-edge/spec.md) specifies its server-side guarantees. Provider credentials, deployment and application validation are not part of this package.

## Run

```sh
bun packages/@overeng/ai-gateway-edge/src/cli.ts serve \
  --config ./gateway.json --bind localhost:8080 --metrics-bind localhost:9090
printf '%s' "$CONSUMER_TOKEN" | bun packages/@overeng/ai-gateway-edge/src/cli.ts hash-token
```

The public flake package is `ai-gateway-edge`; its executable preserves the same `serve --config --bind [--metrics-bind]` and `hash-token` interface:

```sh
nix run github:overengineeringstudio/effect-utils#ai-gateway-edge -- --help
```

The package wraps the published Buck CLI product with Bun. It becomes available when the product publisher records the artifact in the cache manifest; the wrapper does not rebuild source or inject listener settings, consumers, credentials or environment overrides.

The ports above are illustrative. All listener addresses and the upstream are runtime inputs. JSON configuration contains no bearer plaintext:

```json
{
  "upstream": "https://upstream.example",
  "consumers": [{ "name": "example-consumer", "tokenSha256": "<64 lowercase hexadecimal digits>" }]
}
```

Names and verifier digests must each be unique. Removing a verifier and restarting revokes only that consumer. The edge never forwards consumer Authorization to the upstream. Deployment must protect the optional metrics listener; it has no consumer auth.

`upstreamSocket` is an optional absolute Unix-domain socket path. `loadConfig` rejects a relative path before listeners start with typed `UpstreamSocketError`. Startup does not check existence, file type, or permissions: the upstream may bind after edge startup or restart independently. Each request makes a fresh socket connection; connection errors (including missing, refused, or non-socket paths) return HTTP 502 with `{ "error": { "type": "upstream_unavailable", "message": "upstream socket unavailable", "code": null } }`. The error omits paths and system details and is metered once with status 502 under the existing bounded `_rejected` model label. Health reports unavailable while the socket cannot be reached. There is no retry loop or sleep; a later request recovers after the upstream binds or rebinds, without restarting the edge.

When configured, every upstream request, including health probes, uses that socket. `upstream` still supplies the HTTP/HTTPS scheme, Host, and path prefix: for example, `http://upstream.example/prefix/` routes model discovery to `/prefix/v1/models` over the socket without DNS/TCP access to that origin. The Node-compatible HTTP transport streams socket responses and propagates cancellation. Consumer Authorization is stripped, and no upstream credential is added; this socket-based access boundary does not rewrite request bodies. Without the field, the existing TCP/fetch behavior is unchanged. Deployments should put the socket inside a `0700` directory owned by an isolated service user. Other processes running as that same OS user can access the socket; directory permissions do not isolate same-user processes.

Path traversal, symlinks, socket ownership, and permissions are the deployment's responsibility. Socket responses using `gzip`, `deflate`, or `br` are decompressed incrementally before encoding headers are stripped, matching the existing fetch transport. Unknown content encodings and response-adapter failures (including invalid upstream HTTP status values) return the same sanitized 502 envelope rather than escaping the request handler.

`maxModelLabels` is an optional nonnegative integer, defaulting to 64. Request, duration and token metrics retain model labels only for upstream 2xx responses, admit at most this many distinct values, and aggregate further models as `_other`. All non-2xx responses use `_rejected` without consuming the cap. Forwarded model IDs are never rewritten. Set the cap to zero to aggregate all successful models.

`maxRequestBodyBytes` is an optional positive integer, defaulting to 1048576 (1 MiB). After authentication, the edge rejects a declared Content-Length above this limit before reading the body and counts raw bytes incrementally for bodies without a declared length. Exactly the limit is accepted; exceeding it stops reading immediately, before JSON decoding or upstream forwarding. Oversized requests return HTTP 413 with the stable local envelope:

```json
{ "error": { "message": "Request body too large", "type": "gateway_error", "code": null } }
```

## Compose

```ts
import { Schema } from 'effect'

import { GatewayConfig, makeRoutes } from '@overeng/ai-gateway-edge'

const config = Schema.decodeUnknownSync(GatewayConfig)({
  upstream: 'https://upstream.example',
  consumers: [],
})
const { router, metrics } = makeRoutes({ config })
// Provide router to HttpRouter.serve with a NodeHttpServer layer.
// metrics.render() is Prometheus text exposition.
```

Use `loadConfig(path)` with an Effect FileSystem layer for JSON configuration; socket readiness is deliberately checked only by connecting on each request.

The empty table denies all protected operations. Model discovery, chat, structured output, tools and native decision responses pass through without semantic rewriting. Streaming chat forces `include_usage: true` and preserves SSE bytes. Provider usage is counted without inventing missing counts. Local errors have the shared error envelope; upstream errors retain their status and body.

## Conformance

The integration suite loads all 16 shared data-only conformance cases and replays their edge transport projections through a real edge against a fake upstream. `chat.stream.usage` and `decision.invalid-label` use unauthenticated client fake transports: their no-bearer success is not applicable to a protected edge, so replay supplies a fixture bearer. Original-schema validation in `structured.invalid` and label validation in `decision.invalid-label` belong to clients; the edge forwards those invalid outputs unchanged. No case is silently skipped. Edge-specific coverage includes config decoding, bearer revocation isolation, credential/header stripping, malformed requests, usage forcing, plaintext and transport errors, per-consumer metrics, incremental SSE delivery and upstream cancellation on client disconnect.

Published package declarations, tests, workspace membership and cache product registration use the repository's Genie/Buck conventions. The executable source and published CLI require Bun; no host-specific Nix module or provider fork pin is included.
