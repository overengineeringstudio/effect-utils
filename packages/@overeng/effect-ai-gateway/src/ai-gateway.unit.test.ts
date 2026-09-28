import { describe, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted, Schema, Stream } from 'effect'
import { Decision, DecisionModel, LanguageModel } from 'effect/ai'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { expect } from 'vitest'

import { AiGateway } from './mod.ts'

const modelId = 'anthropic/claude-haiku-4-5'
const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }

type RecordedRequest = { url: string; authorization: string | undefined; body: unknown }
const json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeSync(json)
const encodeJson = Schema.encodeSync(json)

const completion = {
  id: 'chatcmpl-test',
  model: modelId,
  created: 1_750_000_000,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage,
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

const decisionResponse = {
  model: 'jev-1.13.0',
  answers: {
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.8,
    },
    urgent: { type: 'noul', noul: 0.7 },
    frustration: {
      type: 'score',
      score: 1.2,
      probabilities: { '0': 0, '1': 0.8, '2': 0.2 },
      legend: { '0': 'calm', '1': 'frustrated', '2': 'angry' },
      confidence: 0.6,
    },
  },
  usage: { input_tokens: 218, output_tokens: 39 },
}

const event = (choices: readonly unknown[], finalUsage: typeof usage | null = null) =>
  `data: ${encodeJson({ id: 'chatcmpl-test', model: modelId, created: 1_750_000_000, choices, usage: finalUsage })}\n\n`

const streamResponse = [
  event([{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }]),
  event([{ index: 0, delta: { content: 'lo!' }, finish_reason: null }]),
  event([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  event([], usage),
  'data: [DONE]\n\n',
].join('')

const fakeHttp = (requests: Array<RecordedRequest>, payload: unknown = completion) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        expect(request.body._tag).toBe('Uint8Array')
        const body =
          request.body._tag === 'Uint8Array'
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined
        requests.push({
          url: url.toString(),
          authorization: request.headers['authorization'],
          body,
        })
        const streaming =
          body !== null &&
          body !== undefined &&
          typeof body === 'object' &&
          'stream' in body &&
          body.stream === true
        return HttpClientResponse.fromWeb(
          request,
          new Response(streaming === true ? streamResponse : encodeJson(payload), {
            headers: {
              'content-type': streaming === true ? 'text/event-stream' : 'application/json',
            },
          }),
        )
      }),
    ),
  )

describe('AiGateway', () => {
  it.effect(
    'sends bearer and unchanged model to /v1/chat/completions and decodes text and usage',
    () => {
      const requests: Array<RecordedRequest> = []
      const ai = AiGateway.layer({
        url: 'http://gateway.test:8080/',
        token: Redacted.make('test-token'),
        model: modelId,
      }).pipe(Layer.provide(fakeHttp(requests)))
      return Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({ prompt: 'Greet me' })
        expect(response.text).toBe('Hello!')
        expect(response.usage.inputTokens.total).toBe(12)
        expect(response.usage.outputTokens.total).toBe(3)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          url: 'http://gateway.test:8080/v1/chat/completions',
          authorization: 'Bearer test-token',
          body: { model: modelId },
        })
      }).pipe(Effect.provide(ai))
    },
  )

  it.effect('requests usage in SSE and decodes text deltas and final token counts', () => {
    const requests: Array<RecordedRequest> = []
    const ai = AiGateway.layer({ url: 'http://gateway.test:8080', model: modelId }).pipe(
      Layer.provide(fakeHttp(requests)),
    )
    return Effect.gen(function* () {
      const parts = Array.from(
        yield* Stream.runCollect(LanguageModel.streamText({ prompt: 'Greet me' })),
      )
      expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
        'Hel',
        'lo!',
      ])
      const finish = parts.find((part) => part.type === 'finish')
      expect(finish?.usage.inputTokens.total).toBe(12)
      expect(finish?.usage.outputTokens.total).toBe(3)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        url: 'http://gateway.test:8080/v1/chat/completions',
        body: { model: modelId, stream: true, stream_options: { include_usage: true } },
      })
      expect(requests[0]?.authorization).toBeUndefined()
    }).pipe(Effect.provide(ai))
  })

  it.effect(
    'loads config and selects a per-call model without changing its provider-prefixed ID',
    () => {
      const requests: Array<RecordedRequest> = []
      const model = 'openai-codex/gpt-5.6-luna'
      const ai = AiGateway.model({ model }).pipe(
        Layer.provide(AiGateway.clientLayerConfig),
        Layer.provide(fakeHttp(requests)),
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
        expect(response.text).toBe('Hello!')
        expect(requests[0]).toMatchObject({
          url: 'http://gateway.test:8080/v1/chat/completions',
          authorization: 'Bearer env-token',
          body: { model },
        })
      }).pipe(Effect.provide(ai))
    },
  )

  it.effect('accepts an absent optional token through layerConfig', () => {
    const requests: Array<RecordedRequest> = []
    const ai = AiGateway.layerConfig({ model: modelId }).pipe(
      Layer.provide(fakeHttp(requests)),
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
      expect(response.text).toBe('Hello!')
      expect(requests[0]?.authorization).toBeUndefined()
      expect(requests[0]).toMatchObject({ body: { model: modelId } })
    }).pipe(Effect.provide(ai))
  })

  it.effect('batches typed decisions with a bearer and default model on /v1/systemone', () => {
    const requests: Array<RecordedRequest> = []
    const ai = AiGateway.decisionLayer({
      url: 'http://gateway.test:8080/',
      token: Redacted.make('decision-token'),
    }).pipe(Layer.provide(fakeHttp(requests, decisionResponse)))
    return Effect.gen(function* () {
      const result = yield* DecisionModel.decide(triage, { input: { ticket: 'Charged twice' } })
      const department: 'billing' | 'technical' = result.answers.department.label
      const frustration: 'calm' | 'frustrated' | 'angry' = result.answers.frustration.label
      expect([department, frustration]).toEqual(['billing', 'frustrated'])
      expect(result.answers).toEqual({
        department: {
          label: 'billing',
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 0.8,
        },
        urgent: { probability: 0.7 },
        frustration: {
          rating: 1.2,
          label: 'frustrated',
          probabilities: { calm: 0, frustrated: 0.8, angry: 0.2 },
          confidence: 0.6,
        },
      })
      expect(result.usage.inputTokens).toBe(218)
      expect(result.usage.outputTokens).toBe(39)
      expect(requests).toEqual([
        {
          url: 'http://gateway.test:8080/v1/systemone',
          authorization: 'Bearer decision-token',
          body: {
            model: 'openrouter/~typesafe/jev-latest',
            state: { ticket: 'Charged twice' },
            questions: {
              department: {
                type: 'choice',
                instructions: 'Which team should handle this?',
                criteria: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
              },
              urgent: { type: 'noul', instructions: 'Needs action today?' },
              frustration: {
                type: 'score',
                instructions: 'How frustrated is the customer?',
                criteria: ['calm', 'frustrated', 'angry'],
              },
            },
          },
        },
      ])
    }).pipe(Effect.provide(ai))
  })

  it.effect('reads decision config with an explicit model and redacted env bearer', () => {
    const requests: Array<RecordedRequest> = []
    const ai = AiGateway.decisionLayerConfig({ model: 'typesafe/alternate' }).pipe(
      Layer.provide(fakeHttp(requests, decisionResponse)),
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

  it.effect('rejects a provider label outside the declared classification', () => {
    const requests: Array<RecordedRequest> = []
    const invalidResponse = {
      ...decisionResponse,
      answers: {
        ...decisionResponse.answers,
        department: { ...decisionResponse.answers.department, choice: 'unexpected' },
      },
    }
    const ai = AiGateway.decisionLayer({ url: 'http://gateway.test' }).pipe(
      Layer.provide(fakeHttp(requests, invalidResponse)),
    )
    return Effect.gen(function* () {
      const error = yield* DecisionModel.decide(triage, {
        input: { ticket: 'Charged twice' },
      }).pipe(Effect.flip)
      expect(error._tag).toBe('AiError')
      expect(error.reason._tag).toBe('InvalidOutputError')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.authorization).toBeUndefined()
    }).pipe(Effect.provide(ai))
  })
})
