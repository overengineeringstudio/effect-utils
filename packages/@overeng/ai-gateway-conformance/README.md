# @overeng/ai-gateway-conformance

Language-neutral, data-only wire cases for AI gateway clients. The consumer
contract and public wire specification are maintained in
[the AI gateway VRS tree](https://github.com/overengineeringstudio/effect-utils/pull/1746).
A case is not a running fake gateway and contains no deployment settings or credentials.

## Case format

Each `cases/<id>.json` file describes one exchange:

- `id`, `summary`, and `requirements` identify the behavior and its `AIG-Rxx` requirements.
- `request` declares method, endpoint path, bearer presence/absence, optional semantic
  matches, and an optional body subset the client must send. Replayers supply their
  own prompts and typed input definitions. `body` is a subset, not a complete request;
  it must not prevent clients from including additional compatible fields.
- `response` contains an HTTP status, optional headers, and exactly one JSON body
  or SSE payload array. Every SSE entry becomes one `data:` event; objects are JSON
  encoded and the literal `[DONE]` is emitted verbatim. Replayers must not add a
  missing terminator or hide an error envelope.
- `expect` records the normalized observable result or failure, including available
  text, original-schema object, token counts, tool calls, native decision answers,
  and error status/type. It does not prescribe language-specific error classes.
- Structured-output cases include `schema`, the caller's original JSON Schema.
  Local validation must enforce its numeric constraints as well as field types.

[`case.schema.json`](./case.schema.json) is the JSON Schema 2020-12 contract.
`src/mod.ts` exports its Effect realization (`Case`), `loadCases()` (requiring a
caller-provided Effect `FileSystem`), and `toHttpClientResponse({ case, request })`
for in-process Effect HTTP replay. The loader validates decoded JSON and rejects
unknown contract fields. Cases are loaded in filename order.

## Adding a case

1. Add a public, credential-free `cases/<id>.json` file whose filename matches its `id`.
2. Link the shared requirement IDs; use realistic gateway/provider envelopes.
   Edge authentication/unavailability errors include `code: null`; upstream errors
   need not. Streaming usage is a chunk with `choices: []`. Error-after-200 cases
   contain an error data payload and no `[DONE]`.
3. Validate the file against `case.schema.json` with a JSON Schema 2020-12 validator.
4. Add caller setup to each realization's replay when the case needs a new operation.
   Assert every expectation that realization can expose. An unsupported expectation
   must appear in a named skip with a concrete reason, never disappear by filtering.
5. Regenerate package metadata with `devenv tasks run genie:run` and run the realization
   tests. Buck's declared `runtimeFiles` carries the JSON corpus and schema in package
   views and archives, so replay does not depend on source-worktree paths.

## Realizations

- **Effect:** `@overeng/effect-ai-gateway` replays these cases in
  `src/ai-gateway.unit.test.ts`, through an injected `HttpClient` without a network
  server. Configuration-specific assertions remain alongside the case replay.
  The pinned compatible provider ignores unknown SSE events, including error data
  envelopes after HTTP 200; `chat.stream.error-after-200` is explicitly skipped
  with that reason. No shared case is silently dropped.
- **Rust:** the `ai-gateway` crate at `rust/ai-gateway` consumes the same JSON corpus
  with a Rust-owned replay harness. No TypeScript fake server or shared fake binary
  is required by the wire contract.

The Effect and Rust realization requirements refine the shared contract; their
runtime, error types, schema implementations, and replay mechanisms are independent.
