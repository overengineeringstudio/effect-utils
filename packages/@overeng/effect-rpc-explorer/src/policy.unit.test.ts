import { Option, Redacted, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { CaptureChannels, type CaptureChannel } from './model.ts'
import { applyCapturePolicy, defaultNormalizationBounds, resolveCapturePolicy } from './policy.ts'

const reveal = { _tag: 'reveal' } as const
const omit = { _tag: 'omit' } as const

const schemaWith = (channel: CaptureChannel) =>
  Schema.String.annotate({ rpcExplorerCapture: { [channel]: reveal } })

describe('capture policy', () => {
  it('resolves every channel independently with host > RPC > root Schema > omit precedence', () => {
    for (const channel of CaptureChannels) {
      const schema = channel === 'headers' ? undefined : schemaWith(channel)
      const host = { [channel]: omit }
      const rpc = { [channel]: reveal }

      expect(resolveCapturePolicy({ channel, host, rpc, schema })).toEqual({
        policy: omit,
        source: 'host',
      })
      expect(resolveCapturePolicy({ channel, rpc, schema })).toEqual({
        policy: reveal,
        source: 'rpc',
      })

      if (channel === 'headers') {
        expect(resolveCapturePolicy({ channel, schema })).toEqual({
          policy: omit,
          source: 'default',
        })
      } else {
        expect(resolveCapturePolicy({ channel, schema })).toEqual({
          policy: reveal,
          source: 'schema',
        })
      }

      expect(resolveCapturePolicy({ channel })).toEqual({
        policy: omit,
        source: 'default',
      })
    }
  })

  it('normalizes nested Redacted values without exposing their backing values', () => {
    const observation = applyCapturePolicy({
      channel: 'requestPayload',
      value: {
        visible: 'ok',
        nested: [Redacted.make('do-not-retain', { label: 'credential' })],
      },
      host: { requestPayload: reveal },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'requestPayload',
      outcome: { _tag: 'Captured', mode: 'reveal', source: 'host' },
      captured: {
        _tag: 'Object',
        value: {
          nested: {
            _tag: 'Array',
            value: [{ _tag: 'Redacted', label: 'credential' }],
          },
          visible: { _tag: 'String', value: 'ok' },
        },
      },
    })
    expect(JSON.stringify(observation)).not.toContain('do-not-retain')
  })

  it('decodes encoded values before reveal so nested Redacted fields stay sealed', () => {
    const secret = 'encoded-nested-secret'
    const schema = Schema.Struct({
      nested: Schema.Struct({
        credential: Schema.Redacted(Schema.String, { label: 'credential' }),
      }),
      visible: Schema.String,
    })
    const observation = applyCapturePolicy({
      channel: 'requestPayload',
      value: {
        nested: { credential: secret },
        visible: 'ok',
      },
      schema,
      encoded: true,
      decodeEncoded: Schema.decodeUnknownOption(Schema.toCodecJson(schema)),
      host: { requestPayload: reveal },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'requestPayload',
      outcome: { _tag: 'Captured', mode: 'reveal', source: 'host' },
      captured: {
        _tag: 'Object',
        value: {
          nested: {
            _tag: 'Object',
            value: {
              credential: { _tag: 'Redacted', label: 'credential' },
            },
          },
          visible: { _tag: 'String', value: 'ok' },
        },
      },
    })
    expect(JSON.stringify(observation)).not.toContain(secret)
  })

  it('decodes encoded values before a redaction transform', () => {
    const secret = 'encoded-redaction-secret'
    const schema = Schema.Struct({
      credential: Schema.Redacted(Schema.String, { label: 'credential' }),
    })
    let transformSawRedacted = false
    const observation = applyCapturePolicy({
      channel: 'requestPayload',
      value: { credential: secret },
      schema,
      encoded: true,
      decodeEncoded: Schema.decodeUnknownOption(Schema.toCodecJson(schema)),
      host: {
        requestPayload: {
          _tag: 'redact',
          transform: (value) => {
            transformSawRedacted =
              typeof value === 'object' &&
              value !== null &&
              'credential' in value &&
              Redacted.isRedacted(value.credential)
            return value
          },
        },
      },
      bounds: defaultNormalizationBounds,
    })

    expect(transformSawRedacted).toBe(true)
    expect(observation).toEqual({
      channel: 'requestPayload',
      outcome: { _tag: 'Captured', mode: 'redact', source: 'host' },
      captured: {
        _tag: 'Object',
        value: {
          credential: { _tag: 'Redacted', label: 'credential' },
        },
      },
    })
    expect(JSON.stringify(observation)).not.toContain(secret)
  })

  it('does not decode an encoded value when policy omits the channel', () => {
    let decodeCalled = false

    const observation = applyCapturePolicy({
      channel: 'requestPayload',
      value: { credential: 'do-not-inspect' },
      schema: Schema.Struct({
        credential: Schema.Redacted(Schema.String),
      }),
      encoded: true,
      decodeEncoded: () => {
        decodeCalled = true
        return Option.none()
      },
      host: { requestPayload: omit },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'requestPayload',
      outcome: { _tag: 'Omitted', source: 'host' },
    })
    expect(decodeCalled).toBe(false)
  })

  it('fails closed without retaining malformed encoded input', () => {
    const secret = 'malformed-encoded-secret'
    const schema = Schema.Struct({ count: Schema.Finite })
    const observation = applyCapturePolicy({
      channel: 'success',
      value: { count: secret },
      schema,
      encoded: true,
      decodeEncoded: Schema.decodeUnknownOption(Schema.toCodecJson(schema)),
      host: { success: reveal },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'success',
      outcome: { _tag: 'PolicyFault', source: 'host', fault: 'normalize' },
    })
    expect(JSON.stringify(observation)).not.toContain(secret)
    expect('captured' in observation).toBe(false)
  })

  it('keeps a root Redacted schema backing value sealed', () => {
    const secret = 'root-redacted-secret'
    const schema = Schema.Redacted(Schema.String, { label: 'root-secret' })
    const observation = applyCapturePolicy({
      channel: 'typedFailure',
      value: secret,
      schema,
      encoded: true,
      decodeEncoded: Schema.decodeUnknownOption(Schema.toCodecJson(schema)),
      host: { typedFailure: reveal },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'typedFailure',
      outcome: { _tag: 'Captured', mode: 'reveal', source: 'host' },
      captured: { _tag: 'Redacted', label: 'root-secret' },
    })
    expect(JSON.stringify(observation)).not.toContain(secret)
  })

  it('fails closed when an encoded reveal has no decoder capability', () => {
    const secret = 'decoder-free-encoded-secret'
    const observation = applyCapturePolicy({
      channel: 'success',
      value: secret,
      schema: Schema.String,
      encoded: true,
      host: { success: reveal },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'success',
      outcome: { _tag: 'PolicyFault', source: 'host', fault: 'normalize' },
    })
    expect(JSON.stringify(observation)).not.toContain(secret)
    expect('captured' in observation).toBe(false)
  })

  it('fails closed when a redaction transform faults', () => {
    const secret = 'transform-secret'
    const observation = applyCapturePolicy({
      channel: 'headers',
      value: { authorization: secret },
      host: {
        headers: {
          _tag: 'redact',
          transform: () => {
            throw new Error(secret)
          },
        },
      },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'headers',
      outcome: { _tag: 'PolicyFault', source: 'host', fault: 'transform' },
    })
    expect(JSON.stringify(observation)).not.toContain(secret)
    expect('captured' in observation).toBe(false)
  })

  it('fails closed when detached normalization cannot safely inspect a value', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    const observation = applyCapturePolicy({
      channel: 'success',
      value: cyclic,
      host: { success: reveal },
      bounds: defaultNormalizationBounds,
    })

    expect(observation).toEqual({
      channel: 'success',
      outcome: { _tag: 'PolicyFault', source: 'host', fault: 'normalize' },
    })
    expect('captured' in observation).toBe(false)
  })
})
