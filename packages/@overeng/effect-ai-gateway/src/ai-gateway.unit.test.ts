import { describe, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted, Schema, Stream } from 'effect'
import { LanguageModel } from 'effect/ai'
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

const event = (choices: readonly unknown[], finalUsage: typeof usage | null = null) =>
  `data: ${encodeJson({ id: 'chatcmpl-test', model: modelId, created: 1_750_000_000, choices, usage: finalUsage })}\n\n`

const streamResponse = [
  event([{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }]),
  event([{ index: 0, delta: { content: 'lo!' }, finish_reason: null }]),
  event([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  event([], usage),
  'data: [DONE]\n\n',
].join('')

const fakeHttp = (requests: Array<RecordedRequest>) =>
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
          new Response(streaming === true ? streamResponse : encodeJson(completion), {
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
})
