import { fileURLToPath } from 'node:url'

import { Effect, FileSystem, Schema } from 'effect'
import type * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

/** Language-neutral replay data. JSON payloads deliberately retain provider fields. */
export const Case = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  requirements: Schema.Array(Schema.String.check(Schema.isPattern(/^AIG-R[0-9]{2}$/))),
  request: Schema.Struct({
    method: Schema.Literals(['GET', 'POST']),
    path: Schema.String.check(Schema.isPattern(/^\//)),
    auth: Schema.Literals(['bearer', 'none']),
    match: Schema.optionalKey(
      Schema.Struct({
        model: Schema.optionalKey(Schema.String),
        stream: Schema.optionalKey(Schema.Boolean),
        responseFormat: Schema.optionalKey(Schema.Literals(['text', 'json_object', 'json_schema'])),
        hasToolResult: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    body: Schema.optionalKey(Schema.JsonObject),
  }),
  response: Schema.Union([
    Schema.Struct({
      status: Schema.Int,
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      json: Schema.Json,
    }),
    Schema.Struct({
      status: Schema.Int,
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      sse: Schema.Array(Schema.Json),
    }),
  ]),
  expect: Schema.Struct({
    outcome: Schema.Literals(['success', 'http-error', 'stream-error', 'validation-error']),
    text: Schema.optionalKey(Schema.String),
    object: Schema.optionalKey(Schema.Json),
    usage: Schema.optionalKey(
      Schema.Struct({
        input: Schema.Int,
        output: Schema.Int,
        total: Schema.optionalKey(Schema.Int),
        cached: Schema.optionalKey(Schema.Int),
      }),
    ),
    toolCalls: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ id: Schema.String, name: Schema.String, arguments: Schema.Json }),
      ),
    ),
    error: Schema.optionalKey(
      Schema.Struct({
        status: Schema.optionalKey(Schema.Int),
        type: Schema.optionalKey(Schema.String),
      }),
    ),
    decision: Schema.optionalKey(Schema.JsonObject),
  }),
  schema: Schema.optionalKey(Schema.JsonObject),
}).annotate({ identifier: 'AiGatewayConformance.Case' })

export type Case = typeof Case.Type

/** Requires the caller's FileSystem layer; works in source and packaged module layouts. */
export const loadCases = Effect.fn('AiGatewayConformance.loadCases')(function* () {
  const fs = yield* FileSystem.FileSystem
  // The source module is in src/; the shipped JS module is in dist/src/.
  // Both layouts keep the corpus as files at the package root, not module exports.
  const directory = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') === true ? '../cases/' : '../../cases/', import.meta.url),
  )
  const files = (yield* fs.readDirectory(directory))
    .filter((file) => file.endsWith('.json'))
    .toSorted()
  return yield* Effect.forEach(files, (file) =>
    fs.readFileString(`${directory}/${file}`).pipe(Effect.flatMap(decodeCase)),
  )
})

/** Render exactly the supplied HTTP status, headers and JSON/SSE data, including incomplete streams. */
export const toHttpClientResponse = ({
  case: replayCase,
  request,
}: {
  readonly case: Case
  readonly request: HttpClientRequest.HttpClientRequest
}): HttpClientResponse.HttpClientResponse => {
  const response = replayCase.response
  const streaming = 'sse' in response
  const body =
    streaming === true
      ? response.sse
          .map((payload) => `data: ${payload === '[DONE]' ? payload : encodeJson(payload)}\n\n`)
          .join('')
      : encodeJson(response.json)
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status: response.status,
      headers: {
        'content-type': streaming === true ? 'text/event-stream' : 'application/json',
        ...response.headers,
      },
    }),
  )
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(Case), {
  onExcessProperty: 'error',
})
