import { Option, Redacted, Schema } from 'effect'

import type {
  CaptureChannel,
  ChannelObservation,
  NormalizationBounds,
  NormalizedValue,
  PolicySource,
} from './model.ts'

/** Whole-channel capture decision; redaction transforms are trusted host code. */
export type CapturePolicy<TValue = unknown> =
  | { readonly _tag: 'omit' }
  | { readonly _tag: 'reveal' }
  | { readonly _tag: 'redact'; readonly transform: (value: TValue) => unknown }

/** Sparse policy map so each capture channel resolves independently. */
export type CapturePolicies<TValue = unknown> = Readonly<
  Partial<Record<CaptureChannel, CapturePolicy<TValue>>>
>

declare module 'effect/Schema' {
  namespace Annotations {
    // eslint-disable-next-line no-shadow -- Effect fixes the public augmentation interface name.
    interface Annotations {
      readonly rpcExplorerCapture?: CapturePolicies | undefined
    }
  }
}

/** Policy inputs ordered from host override through RPC and root Schema metadata. */
export interface PolicyLayers<TValue = unknown> {
  readonly channel: CaptureChannel
  readonly host?: CapturePolicies<TValue> | undefined
  readonly rpc?: CapturePolicies<TValue> | undefined
  readonly schema?: Schema.Top | undefined
}

/** Effective policy together with the precedence layer that supplied it. */
export interface ResolvedCapturePolicy<TValue = unknown> {
  readonly policy: CapturePolicy<TValue>
  readonly source: PolicySource
}

/** Pre-bound decoder capability for one concrete Schema and active transport codec. */
export type EncodedValueDecoder = (value: unknown) => Option.Option<unknown>

const schemaPolicies = (schema: Schema.Top | undefined): CapturePolicies | undefined =>
  schema === undefined ? undefined : Schema.resolveAnnotations(schema)?.rpcExplorerCapture

/** Resolves one channel without inferring access from names or neighboring channels. */
export const resolveCapturePolicy = <TValue = unknown>({
  channel,
  host,
  rpc,
  schema,
}: PolicyLayers<TValue>): ResolvedCapturePolicy<TValue> => {
  const hostPolicy = host?.[channel]
  if (hostPolicy !== undefined) return { policy: hostPolicy, source: 'host' }

  const rpcPolicy = rpc?.[channel]
  if (rpcPolicy !== undefined) return { policy: rpcPolicy, source: 'rpc' }

  if (channel !== 'headers') {
    const schemaPolicy = schemaPolicies(schema)?.[channel]
    if (schemaPolicy !== undefined) return { policy: schemaPolicy, source: 'schema' }
  }

  return { policy: { _tag: 'omit' }, source: 'default' }
}

/** Conservative normalization limits used when the host does not provide tighter bounds. */
export const defaultNormalizationBounds: NormalizationBounds = {
  maxDepth: 16,
  maxEntries: 1_024,
  maxBytes: 64 * 1_024,
}

type NormalizationResult =
  | { readonly _tag: 'Success'; readonly value: NormalizedValue }
  | { readonly _tag: 'Failure' }

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const encodeBase64 = (bytes: Uint8Array): string => {
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    encoded += base64Alphabet[(triple >>> 18) & 63]!
    encoded += base64Alphabet[(triple >>> 12) & 63]!
    encoded += second === undefined ? '=' : base64Alphabet[(triple >>> 6) & 63]!
    encoded += third === undefined ? '=' : base64Alphabet[triple & 63]!
  }
  return encoded
}

const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x7f) {
      bytes += 1
    } else if (codeUnit <= 0x7ff) {
      bytes += 2
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

const normalizedByteLength = (value: NormalizedValue): number => {
  const encoded = JSON.stringify(value)
  return encoded === undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(encoded)
}

/** Detaches supported data into the closed retained algebra without invoking user code. */
export const normalizeValue = ({
  input,
  bounds,
}: {
  readonly input: unknown
  readonly bounds: NormalizationBounds
}): NormalizationResult => {
  const ancestors = new Set<object>()
  let entries = 0

  const visit = ({
    value,
    depth,
  }: {
    readonly value: unknown
    readonly depth: number
  }): NormalizedValue | undefined => {
    entries += 1
    if (entries > bounds.maxEntries || depth > bounds.maxDepth) return undefined

    if (value === null) return { _tag: 'Null' }
    if (Redacted.isRedacted(value) === true) {
      const label = Object.getOwnPropertyDescriptor(value, 'label')
      return label !== undefined && 'value' in label && typeof label.value === 'string'
        ? { _tag: 'Redacted', label: label.value }
        : { _tag: 'Redacted' }
    }

    switch (typeof value) {
      case 'boolean':
        return { _tag: 'Boolean', value }
      case 'number':
        return {
          _tag: 'Number',
          value:
            Number.isNaN(value) === true
              ? 'NaN'
              : value === Number.POSITIVE_INFINITY
                ? '+Infinity'
                : value === Number.NEGATIVE_INFINITY
                  ? '-Infinity'
                  : value,
        }
      case 'string':
        return { _tag: 'String', value }
      case 'bigint':
        return { _tag: 'BigInt', value: String(value) }
      case 'undefined':
      case 'symbol':
      case 'function':
        return { _tag: 'Unsupported', type: typeof value }
      case 'object':
        break
    }

    if (value instanceof Uint8Array) {
      return {
        _tag: 'Bytes',
        base64: encodeBase64(value),
        byteLength: value.byteLength,
      }
    }

    if (ancestors.has(value) === true) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null && Array.isArray(value) === false) {
      return { _tag: 'Unsupported', type: 'object' }
    }

    ancestors.add(value)
    try {
      if (Array.isArray(value) === true) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const length = Object.getOwnPropertyDescriptor(value, 'length')
        if (length === undefined || !('value' in length) || typeof length.value !== 'number') {
          return undefined
        }
        const normalized: Array<NormalizedValue> = []
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = descriptors[String(index)]
          if (descriptor === undefined || !('value' in descriptor)) {
            normalized.push({ _tag: 'Unsupported', type: 'arrayHoleOrAccessor' })
            continue
          }
          const result = visit({ value: descriptor.value, depth: depth + 1 })
          if (result === undefined) return undefined
          normalized.push(result)
        }
        return { _tag: 'Array', value: normalized }
      }

      const descriptors = Object.getOwnPropertyDescriptors(value)
      const normalized: Record<string, NormalizedValue> = {}
      for (const key of Object.keys(descriptors).toSorted()) {
        const descriptor = descriptors[key]!
        if (descriptor.enumerable !== true) continue
        const result =
          'value' in descriptor
            ? visit({ value: descriptor.value, depth: depth + 1 })
            : ({ _tag: 'Unsupported', type: 'accessor' } as const)
        if (result === undefined) return undefined
        Object.defineProperty(normalized, key, {
          value: result,
          enumerable: true,
          configurable: false,
          writable: false,
        })
      }
      return { _tag: 'Object', value: normalized }
    } finally {
      ancestors.delete(value)
    }
  }

  try {
    const value = visit({ value: input, depth: 0 })
    if (value === undefined || normalizedByteLength(value) > bounds.maxBytes) {
      return { _tag: 'Failure' }
    }
    return { _tag: 'Success', value }
  } catch {
    return { _tag: 'Failure' }
  }
}

/** Raw callback value plus the policy and bounds needed before any store insertion. */
export interface ApplyCapturePolicyInput extends PolicyLayers {
  readonly value: unknown
  readonly bounds: NormalizationBounds
  readonly encoded?: boolean | undefined
  readonly decodeEncoded?: EncodedValueDecoder | undefined
}

/** Applies capture policy before returning the only observation shape accepted by the store. */
export const applyCapturePolicy = ({
  value,
  bounds,
  encoded = false,
  decodeEncoded,
  ...layers
}: ApplyCapturePolicyInput): ChannelObservation => {
  const resolved = resolveCapturePolicy(layers)
  if (resolved.policy._tag === 'omit' || resolved.source === 'default') {
    return {
      channel: layers.channel,
      outcome: { _tag: 'Omitted', source: resolved.source },
    }
  }

  let candidate: unknown = value
  if (encoded === true) {
    if (layers.schema === undefined || decodeEncoded === undefined) {
      return {
        channel: layers.channel,
        outcome: {
          _tag: 'PolicyFault',
          source: resolved.source,
          fault: 'normalize',
        },
      }
    }

    let decoded: Option.Option<unknown>
    try {
      decoded = decodeEncoded(value)
    } catch {
      return {
        channel: layers.channel,
        outcome: {
          _tag: 'PolicyFault',
          source: resolved.source,
          fault: 'normalize',
        },
      }
    }
    if (Option.isNone(decoded) === true) {
      return {
        channel: layers.channel,
        outcome: {
          _tag: 'PolicyFault',
          source: resolved.source,
          fault: 'normalize',
        },
      }
    }
    candidate = decoded.value
  }

  if (resolved.policy._tag === 'redact') {
    try {
      candidate = resolved.policy.transform(candidate)
    } catch {
      return {
        channel: layers.channel,
        outcome: {
          _tag: 'PolicyFault',
          source: resolved.source,
          fault: 'transform',
        },
      }
    }
  }

  const normalized = normalizeValue({ input: candidate, bounds })
  if (normalized._tag === 'Failure') {
    return {
      channel: layers.channel,
      outcome: {
        _tag: 'PolicyFault',
        source: resolved.source,
        fault: 'normalize',
      },
    }
  }

  return {
    channel: layers.channel,
    outcome: {
      _tag: 'Captured',
      mode: resolved.policy._tag,
      source: resolved.source,
    },
    captured: normalized.value,
  }
}
