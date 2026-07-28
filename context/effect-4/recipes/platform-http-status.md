# Pattern: platform-http-status

**Area:** Platform / HttpClient  **Kind:** semantic  **Our usage:** direct HttpClient imports are
low-volume, but HTTP failure matching is a control-flow boundary in clients and telemetry.

## v3

```ts
import { HttpClient, HttpClientResponse } from "@effect/platform"

const response = yield* HttpClient.get(url).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk)
)
```

Rejected status fails with `ResponseError`, `reason: "StatusCode"`.

## v4

```ts
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const response = yield* HttpClient.get(url).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk)
)
```

Rejected status fails with `HttpClientError` wrapping `StatusCodeError`.

## Equivalence

```sh
bun run run platform-http-status
```

A deterministic local server returns exact 200 and 418 bodies. The 2xx status/body branch is
identical. The 418 status remains identical, while the error wrapper and reason tag differ at two
explicitly allowlisted paths.

## Intended differences (alignment register entries)

- Accept the v4 error wrapper, but rewrite `catchTag("ResponseError")` and
  `error.reason === "StatusCode"` branches to match `HttpClientError` and inspect
  `error.reason._tag === "StatusCodeError"`.

## Gotchas

- `HttpClient.get` itself does not turn every non-2xx response into failure; this probe exercises
  `filterStatusOk`, the API whose rejection shape changed.
- Tests that only assert the numeric status miss the control-flow break: old `catchTag` handlers
  stop matching even though the status is still 418.
- Keep local deterministic servers in migration gates; real network failures add unrelated drift.

## Codemod rule

The import move is mechanical. Error-handler rewrites are semantic and must be paired with a
non-2xx branch test.
