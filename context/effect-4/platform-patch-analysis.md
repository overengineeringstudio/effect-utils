# Effect 4 header-allowlist patch: recommendation

Identity: `org.schickling.eu.effect-4.patch`  
Target: `effect@4.0.0-beta.102`

## Verdict

**The patch cannot retire through `HttpClientRequest.updateHeaders` or
`removeHeader`; it must be re-expressed.**

Use a minimal beta.102 `effect` core patch at the two header-attribute loops as
the migration-critical-path measure, and bring a configurable upstream header
attribute predicate/allowlist proposal to Effect. Do not implement the behavior
as a `utils` wrapper: a faithful wrapper would have to replace Effect's complete
client tracing lifecycle and would be a much larger, silently drift-prone fork.

## Q1: exact patched-v3 behavior

The existing patch defines one case-insensitive allowlist used for both request
and response span attributes:

1. `content-type`
2. `content-length`
3. `date`
4. `x-request-id`
5. `x-notion-request-id`
6. `retry-after`
7. `x-ratelimit-remaining`

Request lifecycle:

- `@effect/platform@0.96.2` creates the `http.client` span and adds method,
  server, URL, path, scheme, and query attributes.
- It reads `Headers.currentRedactedNames`, redacts the request header values,
  then iterates the resulting header record.
- The patch emits only allowlisted names as
  `http.request.header.<name> = String(redactedValue)`.
- This happens before trace-context headers are added and before the request is
  handed to the transport, so generated `b3`/`traceparent` headers are not
  captured as request header attributes.

Response lifecycle:

- On a successful transport response it first adds
  `http.response.status_code`.
- It redacts the response headers using the request-time redaction set, then
  emits only allowlisted names as
  `http.response.header.<name> = String(redactedValue)`.
- This occurs before the response is returned/wrapped.

With the patch, non-allowlisted attributes are absent, including headers whose
values would otherwise be represented as `"<redacted>"`. Without the patch,
both loops emit every request/response header name after value redaction.

## Q2: why the beta.102 combinators cannot express it

At beta.102:

- `HttpClientRequest.updateHeaders` reconstructs the immutable request with
  `f(self.headers)` as its actual headers
  (`src/unstable/http/HttpClientRequest.ts:384-407`).
- `removeHeader` is just `updateHeaders(self, Headers.remove(key))`
  (`HttpClientRequest.ts:415-433`).
- `HttpClient.make` traces the resulting request headers at
  `src/unstable/http/HttpClient.ts:841-845`, then passes that same request to
  the transport at line 850.
- The response header loop is internal to `HttpClient.make` at lines 853-858.
  No request combinator can observe or filter it.

Probe:

```text
tmp/patch-probe/probe.ts
command: bun tmp/patch-probe/probe.ts
effect: 4.0.0-beta.102
```

The baseline sent all original application headers and emitted:

```json
{
  "http.request.header.authorization": "<redacted>",
  "http.request.header.content-type": "application/json",
  "http.request.header.x-noise": "noise",
  "http.request.header.x-request-id": "request-123",
  "http.response.header.content-type": "text/plain",
  "http.response.header.date": "Tue, 28 Jul 2026 10:00:00 GMT",
  "http.response.header.set-cookie": "<redacted>",
  "http.response.header.x-response-noise": "noise"
}
```

Applying an allowlist with
`HttpClient.mapRequest(client, HttpClientRequest.updateHeaders(filterHeaders))`:

- removed `authorization` and `x-noise` from the actual transport request;
- removed their request span attributes;
- still emitted `http.response.header.set-cookie = "<redacted>"`;
- still emitted `http.response.header.x-response-noise = "noise"`.

Therefore the candidate both changes functional HTTP behavior and fails to
reproduce patched-v3 telemetry behavior.

## Exact beta.102 header emission and value-redaction behavior

`HttpClient.make` emits one span attribute for **every header name present**:

- request: `http.request.header.<lowercase-name>`;
- successful response: `http.response.header.<lowercase-name>`.

`Headers.CurrentRedactedNames` defaults to `authorization`, `cookie`,
`set-cookie`, and `x-api-key`
(`src/unstable/http/Headers.ts:714-733`). Those four values are emitted as the
literal string `"<redacted>"`; their attributes are not omitted. Every other
header value is emitted raw unless the application has added its name/pattern
to `CurrentRedactedNames`.

`CurrentRedactedNames` is a configurable `Context.Reference`, so consumers can
extend or replace that list to protect additional values. The remaining gap is
separate from value redaction: even after a value is redacted, consumers have
no supported way to suppress the request or response header attribute itself.
Header-name presence, telemetry shape, and per-span attribute cardinality
therefore remain uncontrollable.

The response side is the decisive API gap: there is no response-header
attribute hook at all.

## Q3: minimal alternative, ranked

### 1. Upstream configurable predicate/allowlist (principled destination)

Add a client tracing configuration hook used by both internal loops, for
example a context reference receiving direction and normalized header name:

```ts
type HeaderAttributePredicate = (direction: 'request' | 'response', name: string) => boolean
```

It can default to `true` for compatibility. Effect-utils would provide a
predicate backed by the existing seven-name allowlist. This separates
transmission headers from telemetry policy and covers the currently
unreachable response path.

### 2. Local beta.102 core patch (recommended migration measure)

Patch `effect/dist/unstable/http/HttpClient.js` at the equivalent request and
response loops (runtime lines 264-266 and 274-276 in the installed beta.102
artifact), using the same seven-name `Set` and the same case-insensitive
`continue` checks as patched v3. Mirror it in
`effect/src/unstable/http/HttpClient.ts` if the package patch convention keeps
published source consistent.

This is the smallest faithful change: it preserves transport, trace
propagation, span lifecycle, response wrapping, interruption behavior, and all
non-header attributes. It must be re-derived on every beta bump, but patch
failure is loud and beta.102 is hard-pinned.

### 3. `utils` wrapper (not recommended)

`HttpClient.transform` runs outside the internal postprocess and receives no
span handle; span attributes cannot be deleted after the internal response
loop. A wrapper would have to disable built-in tracing and reproduce span
creation, URL attributes, request redaction, trace-context propagation, parent
span wiring, response status/headers, failures, interruption, and scoped
response behavior.

That wrapper may keep compiling across beta bumps, but it can silently diverge
from Effect's tracing semantics. The core patch is mechanically more brittle
but behaviorally safer and much smaller.

## Upstream status

Do not file a new issue: Effect-TS/effect#6363 already requests this exact
header-attribute predicate and is open.

Draft PR Effect-TS/effect#6697 implements `HttpClient.TracerHeaderFilter` with a
`constTrue` default, applies it to both request and response loops, and tests
default inclusion plus selective suppression on both paths.

The local beta.102 core patch remains the migration bridge while #6697 is
unmerged. It should be designed for direct deletion as soon as an Effect
release containing the upstream reference is adopted.

## Q4: differential proof required for the re-expressed patch

Run patched v3 and patched v4 as separate processes with identical synthetic
inputs and recording in-memory OpenTelemetry exporters. Use a low-level client
runner so no network normalization can differ between processes.

Each side should emit normalized JSON containing:

1. the transport-received application request headers;
2. the returned response headers;
3. the complete client span name/status and sorted attributes.

Fixture matrix:

- all seven allowlisted names on request and response paths;
- mixed-case input names, asserting normalized attribute names;
- non-allowlisted non-sensitive request and response headers;
- default-redacted `authorization` on request and `set-cookie` on response,
  asserting the attributes are **absent**, not `"<redacted>"`;
- a custom header added to the redaction set, also asserting absence;
- trace propagation enabled, asserting the transport receives propagation
  headers while those injected headers are not added to header attributes.

Gates:

- v3-v4 normalized JSON bytes are identical;
- all original application request headers reach transport unchanged;
- returned response headers are unchanged;
- exactly the seven-name intersection is present under
  `http.request.header.*` / `http.response.header.*`;
- status, URL, method, parentage, propagation, and error behavior remain
  unchanged.

## Second patch

`@myobie/pty@0.10.0` is unrelated to Effect: it only changes two
`@xterm/addon-serialize` default imports to namespace imports for ESM export
compatibility.
