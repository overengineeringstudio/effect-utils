import { Effect, Schema } from 'effect'

import type { Signal } from './Otelite.ts'

type OtelAttributeValue = string | number | boolean

type OtelAttributeMap = Readonly<Record<string, OtelAttributeValue>>

const OteliteLabelAttrs = Schema.Struct({
  label: Schema.NonEmptyString,
})

const OteliteExecAttrs = Schema.Struct({
  label: Schema.NonEmptyString,
  argv: Schema.Array(Schema.String),
})

const OteliteSignalAttrs = Schema.Struct({
  label: Schema.NonEmptyString,
  signal: Schema.Literal('traces', 'metrics', 'logs'),
})

const encodeLabelAttrs = Schema.decodeSync(OteliteLabelAttrs)
const encodeExecAttrs = Schema.decodeSync(OteliteExecAttrs)
const encodeSignalAttrs = Schema.decodeSync(OteliteSignalAttrs)

const withSpan =
  ({
    name,
    attributes,
    root,
  }: {
    readonly name: string
    readonly attributes: OtelAttributeMap
    readonly root?: boolean
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.withSpan(name, { attributes, ...(root === undefined ? {} : { root }) }))

export const withOteliteExecSpan = (argv: ReadonlyArray<string>) =>
  withSpan({
    name: 'otelite.exec',
    attributes: (() => {
      const value = encodeExecAttrs({ label: argv[0] ?? 'exec', argv })
      return {
        'span.label': value.label,
        'otelite.argv': JSON.stringify(value.argv),
      }
    })(),
  })

export const withOteliteLabelSpan = (name: string, label: string = name.replace('otelite.', '')) =>
  withSpan({
    name,
    attributes: (() => {
      const value = encodeLabelAttrs({ label })
      return { 'span.label': value.label }
    })(),
  })

export const withOteliteInspectSummarySpan = (signal: Signal) =>
  withSpan({
    name: 'otelite.inspect.summary',
    attributes: (() => {
      const value = encodeSignalAttrs({ label: signal, signal })
      return { 'span.label': value.label, signal: value.signal }
    })(),
  })

export const withOteliteInspectSpan = (signal: Signal) =>
  withSpan({
    name: 'otelite.inspect',
    attributes: (() => {
      const value = encodeSignalAttrs({ label: signal, signal })
      return { 'span.label': value.label, signal: value.signal }
    })(),
  })

export const withOteliteRootSpan =
  ({ name, label }: { readonly name: string; readonly label: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      withSpan({
        name,
        root: true,
        attributes: (() => {
          const value = encodeLabelAttrs({ label })
          return { 'span.label': value.label }
        })(),
      }),
    )
