import { OpenAiClient } from '@effect/ai-openai-compat'
import { NodeFileSystem } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted, Schema, Stream } from 'effect'
import { Decision, DecisionModel, LanguageModel, Prompt, Tool, Toolkit } from 'effect/ai'
import * as AiError from 'effect/ai/AiError'
import type * as Response from 'effect/ai/Response'
import * as HttpClient from 'effect/http/HttpClient'
import { expect } from 'vitest'

import { Case, loadCases, toHttpClientResponse } from '@overeng/ai-gateway-conformance'

import { AiGateway } from './mod.ts'

// Load committed data once during test registration; replay itself performs no filesystem/network I/O.
const cases = await Effect.runPromise(loadCases().pipe(Effect.provide(NodeFileSystem.layer)))
const modelId = 'anthropic/claude-haiku-4-5'
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json))
const errorBody = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ type: Schema.String }) }),
)

type RecordedRequest = {
  method: string
  url: string
  authorization: string | undefined
  body: Schema.Json | undefined
}

const fakeHttp = ({
  requests,
  case: replayCase,
}: {
  requests: Array<RecordedRequest>
  case: Case
}) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        if (request.method === 'POST') expect(request.body._tag).toBe('Uint8Array')
        requests.push({
          method: request.method,
          url: url.toString(),
          authorization: request.headers['authorization'],
          body:
            request.body._tag === 'Uint8Array'
              ? decodeJson(new TextDecoder().decode(request.body.body))
              : undefined,
        })
        return toHttpClientResponse({ case: replayCase, request })
      }),
    ),
  )

const caseById = (id: string): Case => {
  const replayCase = cases.find((entry) => entry.id === id)
  expect(replayCase, `Missing conformance case ${id}`).toBeDefined()
  return Schema.decodeUnknownSync(Case)(replayCase)
}

const triage = Decision.make({
  input: Schema.Struct({ ticket: Schema.String }),
  decisions: {
    department: Decision.classify({
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
    }),
    urgent: Decision.probability({ instructions: 'Needs action today?' }),
    frustration: Decision.rate({
      instructions: 'How frustrated is the customer?',
      criteria: ['calm', 'frustrated', 'angry'],
    }),
  },
})

const person = Schema.Struct({
  name: Schema.String,
  age: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  tags: Schema.Array(Schema.String),
})

const weather = Toolkit.make(
  Tool.make('get_weather', {
    description: 'Look up the weather in a city',
    parameters: Schema.Struct({ city: Schema.String }),
    success: Schema.Struct({ weather: Schema.String }),
  }),
)

const toolResultPrompt = Prompt.make([
  Prompt.userMessage({ content: [Prompt.textPart({ text: 'What is the weather in Berlin?' })] }),
  Prompt.assistantMessage({
    content: [
      Prompt.toolCallPart({
        id: 'call_1',
        name: 'get_weather',
        params: { city: 'Berlin' },
        providerExecuted: false,
      }),
    ],
  }),
  Prompt.toolMessage({
    content: [
      Prompt.toolResultPart({
        id: 'call_1',
        name: 'get_weather',
        result: { weather: 'sunny' },
        isFailure: false,
        providerExecuted: false,
      }),
    ],
  }),
])

const assertRequest = ({
  case: replayCase,
  requests,
}: {
  case: Case
  requests: Array<RecordedRequest>
}) => {
  expect(requests).toHaveLength(1)
  const recorded = requests[0]
  expect(recorded).toMatchObject({
    method: replayCase.request.method,
    url: `http://gateway.test:8080${replayCase.request.path}`,
    authorization: replayCase.request.auth === 'bearer' ? 'Bearer test-token' : undefined,
  })
  if (replayCase.request.body !== undefined)
    expect(recorded?.body).toMatchObject(replayCase.request.body)
  const match = replayCase.request.match
  if (match?.model !== undefined) expect(recorded?.body).toMatchObject({ model: match.model })
  if (match?.stream === true) expect(recorded?.body).toMatchObject({ stream: true })
  if (match?.stream === false) expect(recorded?.body).not.toMatchObject({ stream: true })
  if (match?.responseFormat !== undefined) {
    expect(recorded?.body).toMatchObject({ response_format: { type: match.responseFormat } })
  }
  if (match?.hasToolResult !== undefined) {
    const body = Schema.decodeUnknownSync(
      Schema.Struct({ messages: Schema.Array(Schema.JsonObject) }),
    )(recorded?.body)
    expect(body.messages.some((message) => message.role === 'tool')).toBe(match.hasToolResult)
  }
}

const assertUsage = ({ case: replayCase, usage }: { case: Case; usage: Response.Usage }) => {
  if (replayCase.expect.usage === undefined) return
  expect(usage.inputTokens.total).toBe(replayCase.expect.usage.input)
  expect(usage.outputTokens.total).toBe(replayCase.expect.usage.output)
  if (replayCase.expect.usage.cached !== undefined) {
    expect(usage.inputTokens.cacheRead).toBe(replayCase.expect.usage.cached)
  }
  if (replayCase.expect.usage.total !== undefined) {
    expect((usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0)).toBe(
      replayCase.expect.usage.total,
    )
  }
}

/** Keep validation replay enabled while naming the missing billed-usage guarantees. */
const skippedErrorUsage: Record<string, string> = {
  'structured.invalid':
    'LanguageModel.generateObject constructs StructuredOutputError without retaining response usage.',
  'decision.invalid-label':
    'DecisionModel validates answers with InvalidOutputError without retaining response usage.',
}

const assertError = ({ case: replayCase, error }: { case: Case; error: AiError.AiError }) => {
  expect(error._tag).toBe('AiError')
  if (replayCase.expect.outcome === 'validation-error') {
    expect(error.reason._tag).toBe(
      replayCase.request.path === '/v1/systemone' ? 'InvalidOutputError' : 'StructuredOutputError',
    )
  }
  if (replayCase.expect.usage !== undefined && skippedErrorUsage[replayCase.id] === undefined) {
    expect('usage' in error.reason ? error.reason.usage : undefined).toMatchObject({
      promptTokens: replayCase.expect.usage.input,
      completionTokens: replayCase.expect.usage.output,
      ...(replayCase.expect.usage.total !== undefined
        ? { totalTokens: replayCase.expect.usage.total }
        : {}),
    })
  }
  if (replayCase.expect.error?.status !== undefined) {
    expect('http' in error.reason ? error.reason.http?.response?.status : undefined).toBe(
      replayCase.expect.error.status,
    )
  }
  if (replayCase.expect.error?.type !== undefined) {
    // Both providers retain the HTTP error body; TypeSafe does not expose nested wire types as metadata.
    const body = 'http' in error.reason ? error.reason.http?.body : undefined
    expect(Schema.decodeUnknownSync(errorBody)(body).error.type).toBe(replayCase.expect.error.type)
    if (replayCase.request.path === '/v1/chat/completions') {
      // Generic auth/server reasons use flat metadata; provider-specific reasons namespace it.
      const metadata = 'metadata' in error.reason ? error.reason.metadata : undefined
      const providerMetadata =
        metadata !== undefined && 'openai' in metadata ? metadata.openai : metadata
      expect(providerMetadata).toMatchObject({ errorType: replayCase.expect.error.type })
    }
  }
}

/** Explicit upstream gaps: adding a case never silently removes it from replay. */
const skippedCases: Record<string, string> = {
  'chat.stream.error-after-200':
    'The compatible provider ignores UnknownChatCompletionEvent, including error data envelopes after HTTP 200; it cannot assert a stream-error outcome or error type.',
}

describe('AiGateway shared wire conformance', () => {
  for (const replayCase of cases) {
    const skipReason = skippedCases[replayCase.id]
    if (skipReason !== undefined) {
      it.skip(`${replayCase.id}: ${skipReason}`, () => {})
      continue
    }
    const usageSkipReason = skippedErrorUsage[replayCase.id]
    if (usageSkipReason !== undefined) {
      it.skip(`${replayCase.id}: validation-error usage retention: ${usageSkipReason}`, () => {})
    }
    const replay = Effect.gen(function* () {
      const requests: Array<RecordedRequest> = []
      const settings = {
        url: 'http://gateway.test:8080/',
        ...(replayCase.request.auth === 'bearer' ? { token: Redacted.make('test-token') } : {}),
      }
      const http = fakeHttp({ requests, case: replayCase })
      if (replayCase.request.path === '/v1/models') {
        return yield* Effect.gen(function* () {
          expect(replayCase.expect.outcome).toBe('success')
          const client = yield* OpenAiClient.OpenAiClient
          const response = yield* client.client.get('/models')
          expect(yield* response.json).toEqual(replayCase.expect.object)
          expect(response.status).toBe(replayCase.response.status)
          assertRequest({ case: replayCase, requests })
        }).pipe(Effect.provide(AiGateway.clientLayer(settings).pipe(Layer.provide(http))))
      }
      if (replayCase.request.path === '/v1/systemone') {
        return yield* Effect.gen(function* () {
          const operation = DecisionModel.decide(triage, { input: { ticket: 'Charged twice' } })
          if (replayCase.expect.outcome === 'success') {
            const result = yield* operation
            const department: 'billing' | 'technical' = result.answers.department.label
            const frustration: 'calm' | 'frustrated' | 'angry' = result.answers.frustration.label
            expect([department, frustration]).toEqual(['billing', 'frustrated'])
            expect(result.answers).toEqual(replayCase.expect.decision)
            expect(result.usage.inputTokens).toBe(replayCase.expect.usage?.input)
            expect(result.usage.outputTokens).toBe(replayCase.expect.usage?.output)
            expect(requests[0]?.body).toEqual(replayCase.request.body)
          } else {
            assertError({ case: replayCase, error: yield* operation.pipe(Effect.flip) })
          }
          assertRequest({ case: replayCase, requests })
        }).pipe(Effect.provide(AiGateway.decisionLayer(settings).pipe(Layer.provide(http))))
      }
      expect(replayCase.request.path).toBe('/v1/chat/completions')
      return yield* Effect.gen(function* () {
        if (replayCase.schema !== undefined) {
          // This typed caller schema must remain equivalent to the original schema carried by the case.
          expect(Schema.toJsonSchemaDocument(person, { onExcessProperty: 'error' }).schema).toEqual(
            replayCase.schema,
          )
          const operation = LanguageModel.generateObject({ prompt: 'Describe Ada', schema: person })
          if (replayCase.expect.outcome === 'success') {
            const result = yield* operation
            expect(result.value).toEqual(replayCase.expect.object)
            assertUsage({ case: replayCase, usage: result.usage })
          } else {
            assertError({ case: replayCase, error: yield* operation.pipe(Effect.flip) })
          }
        } else if (replayCase.request.match?.stream === true) {
          expect(replayCase.expect.outcome).toBe('success')
          const parts = Array.from(
            yield* Stream.runCollect(LanguageModel.streamText({ prompt: 'Greet me' })),
          )
          const deltas = parts
            .filter((part) => part.type === 'text-delta')
            .map((part) => part.delta)
          expect(deltas).toEqual(['Hel', 'lo!'])
          expect(deltas.join('')).toBe(replayCase.expect.text)
          const finish = parts.find((part) => part.type === 'finish')
          expect(finish).toBeDefined()
          if (finish !== undefined) assertUsage({ case: replayCase, usage: finish.usage })
        } else {
          const operation = Effect.gen(function* () {
            if (replayCase.id.startsWith('tools.')) {
              return yield* LanguageModel.generateText({
                prompt:
                  replayCase.request.match?.hasToolResult === true ? toolResultPrompt : 'Greet me',
                toolkit: weather,
                disableToolCallResolution: true,
              })
            }
            return yield* LanguageModel.generateText({ prompt: 'Greet me' })
          })
          if (replayCase.expect.outcome === 'success') {
            const result = yield* operation
            if (replayCase.expect.text !== undefined)
              expect(result.text).toBe(replayCase.expect.text)
            if (replayCase.expect.toolCalls !== undefined) {
              expect(
                result.content.flatMap((part) =>
                  part.type === 'tool-call'
                    ? [
                        {
                          id: part.id,
                          name: part.name,
                          arguments: part.params,
                        },
                      ]
                    : [],
                ),
              ).toEqual(replayCase.expect.toolCalls)
              expect(result.content.some((part) => part.type === 'tool-result')).toBe(false)
            }
            assertUsage({ case: replayCase, usage: result.usage })
          } else {
            assertError({ case: replayCase, error: yield* operation.pipe(Effect.flip) })
          }
        }
        assertRequest({ case: replayCase, requests })
      }).pipe(
        Effect.provide(
          AiGateway.layer({
            ...settings,
            model: replayCase.request.match?.model ?? modelId,
          }).pipe(Layer.provide(http)),
        ),
      )
    })
    it.effect(`${replayCase.id}: ${replayCase.summary}`, () => replay)
  }
})

describe('AiGateway configuration', () => {
  it.effect('loads config and selects a per-call provider-prefixed model unchanged', () => {
    const requests: Array<RecordedRequest> = []
    const model = 'openai-codex/gpt-5.6-luna'
    const ai = AiGateway.model({ model }).pipe(
      Layer.provide(AiGateway.clientLayerConfig),
      Layer.provide(fakeHttp({ requests, case: caseById('chat.text') })),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            AI_GATEWAY_URL: 'http://gateway.test:8080',
            AI_GATEWAY_TOKEN: 'env-token',
          }),
        ),
      ),
    )
    return Effect.gen(function* () {
      const response = yield* LanguageModel.generateText({ prompt: 'Greet me' })
      expect(response.text).toBe(caseById('chat.text').expect.text)
      expect(requests[0]).toMatchObject({
        url: 'http://gateway.test:8080/v1/chat/completions',
        authorization: 'Bearer env-token',
        body: { model },
      })
    }).pipe(Effect.provide(ai))
  })

  it.effect('accepts an absent optional token through layerConfig', () => {
    const requests: Array<RecordedRequest> = []
    const ai = AiGateway.layerConfig({ model: modelId }).pipe(
      Layer.provide(fakeHttp({ requests, case: caseById('chat.text') })),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            AI_GATEWAY_URL: 'http://gateway.test:8080/',
          }),
        ),
      ),
    )
    return Effect.gen(function* () {
      const response = yield* LanguageModel.generateText({ prompt: 'Greet me' })
      expect(response.text).toBe(caseById('chat.text').expect.text)
      expect(requests[0]?.authorization).toBeUndefined()
      expect(requests[0]).toMatchObject({ body: { model: modelId } })
    }).pipe(Effect.provide(ai))
  })

  it.effect('reads decision config with an explicit model and redacted env bearer', () => {
    const requests: Array<RecordedRequest> = []
    const ai = AiGateway.decisionLayerConfig({ model: 'typesafe/alternate' }).pipe(
      Layer.provide(fakeHttp({ requests, case: caseById('decision.triage') })),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            AI_GATEWAY_URL: 'http://gateway.test/',
            AI_GATEWAY_TOKEN: 'env-decision-token',
          }),
        ),
      ),
    )
    return Effect.gen(function* () {
      yield* DecisionModel.decide(triage, { input: { ticket: 'Charged twice' } })
      expect(requests[0]).toMatchObject({
        url: 'http://gateway.test/v1/systemone',
        authorization: 'Bearer env-decision-token',
        body: { model: 'typesafe/alternate' },
      })
    }).pipe(Effect.provide(ai))
  })
})
