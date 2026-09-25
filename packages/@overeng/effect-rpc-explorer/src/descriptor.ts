import { Context, type JsonSchema, Schema } from 'effect'
import * as OpenApi from 'effect/unstable/httpapi/OpenApi'
import { Rpc, type RpcGroup, RpcSchema } from 'effect/unstable/rpc'

import type { CaptureChannel } from './model.ts'

/** Per-RPC switch used to keep the explorer's own inspector traffic out of observation. */
export const RpcExplorerObserve = Context.Reference<boolean>(
  '@overeng/effect-rpc-explorer/RpcExplorerObserve',
  { defaultValue: () => true },
)

/** Whether protocol observations for an RPC enter the explorer pipeline. */
export type ObservationInclusion = 'include' | 'exclude'

/** A serializable, best-effort view of one capture channel's schema. */
export interface DescriptorChannel {
  readonly schema?: JsonSchema.Document<'draft-2020-12'> | undefined
  readonly projection: 'available' | 'unavailable' | 'bestEffort'
  readonly warning?: string | undefined
}

/** Live schema metadata retained only by the in-process descriptor. */
export interface LiveDescriptorChannel {
  readonly schema: Schema.Top
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/** Public RPC metadata that capture and policy resolution need at runtime. */
export interface LiveRpcDescriptor {
  readonly payloadSchema: Schema.Top
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly defectSchema: Schema.Top
  readonly terminalSchema: Schema.Top
  readonly annotations: Context.Context<never>
  readonly channels: Readonly<Partial<Record<CaptureChannel, LiveDescriptorChannel>>>
}

/** Stable logical-RPC description shared by the core and presentation adapters. */
export interface RpcDescriptor {
  readonly descriptorId: string
  readonly key: string
  readonly tag: string
  readonly title?: string | undefined
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly deprecated?: boolean | undefined
  readonly kind: 'unary' | 'stream'
  readonly observe: ObservationInclusion
  readonly channels: Readonly<Record<CaptureChannel, DescriptorChannel>>
  readonly terminal: DescriptorChannel
  /** Omitted when a descriptor is projected onto an inspector wire model. */
  readonly live?: LiveRpcDescriptor | undefined
}

const unavailableChannel: DescriptorChannel = { projection: 'unavailable' }
const schemaFreeChannel: DescriptorChannel = { projection: 'available' }
const projectionWarning = 'JSON Schema projection unavailable'
const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) return true
  }
  return false
}

interface ProjectedSchema {
  readonly descriptor: DescriptorChannel
  readonly live: LiveDescriptorChannel
}

const projectSchema = (schema: Schema.Top): ProjectedSchema => {
  try {
    const annotations = Schema.resolveAnnotations(schema)
    const live = annotations === undefined ? { schema } : { schema, annotations }

    return {
      descriptor: {
        schema: Schema.toJsonSchemaDocument(schema),
        projection: 'bestEffort',
      },
      live,
    }
  } catch {
    return {
      descriptor: {
        projection: 'unavailable',
        warning: projectionWarning,
      },
      live: { schema },
    }
  }
}

const descriptorIdFromKey = (key: string): string => {
  if (key.length === 0 || hasControlCharacter(key) === true) {
    throw new RangeError('RPC descriptor keys must be non-empty and contain no control characters')
  }
  return `rpc:${key}`
}

/** Projects an RpcGroup in its deterministic request-map iteration order. */
export const makeRpcDescriptors = (group: RpcGroup.Any): ReadonlyArray<RpcDescriptor> => {
  const descriptors: Array<RpcDescriptor> = []

  // RpcGroup.Any erases the concrete Rpc union and its request map; a
  // constrained AnyWithProps generic rejects the middleware-carrying groups
  // the explorer exists to observe (middleware service variance under
  // exactOptionalPropertyTypes), so recover the map through one named cast.
  const requestsOf = group as unknown as {
    readonly requests: ReadonlyMap<string, Rpc.AnyWithProps>
  }
  for (const rpc of requestsOf.requests.values()) {
    const descriptorId = descriptorIdFromKey(rpc.key)
    const payload = projectSchema(rpc.payloadSchema)
    const defect = projectSchema(rpc.defectSchema)
    const terminalSchema = Rpc.exitSchema(rpc)
    const terminal = projectSchema(terminalSchema)
    const isStream = RpcSchema.isStreamSchema(rpc.successSchema)

    const success = isStream === true ? undefined : projectSchema(rpc.successSchema)
    const typedFailure = isStream === true ? undefined : projectSchema(rpc.errorSchema)
    const streamElement = isStream === true ? projectSchema(rpc.successSchema.success) : undefined
    const streamError = isStream === true ? projectSchema(rpc.successSchema.error) : undefined
    // Rpc.AnyWithProps erases the annotation service union, not the Context values.
    const annotations = rpc.annotations as Context.Context<
      OpenApi.Title | OpenApi.Summary | OpenApi.Description | OpenApi.Deprecated
    >
    const title = Context.getOrUndefined(annotations, OpenApi.Title)
    const summary = Context.getOrUndefined(annotations, OpenApi.Summary)
    const description = Context.getOrUndefined(annotations, OpenApi.Description)
    const deprecated = Context.getOrUndefined(annotations, OpenApi.Deprecated)

    descriptors.push({
      descriptorId,
      key: rpc.key,
      tag: rpc._tag,
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
      ...(description === undefined ? {} : { description }),
      ...(deprecated === undefined ? {} : { deprecated }),
      kind: isStream === true ? 'stream' : 'unary',
      observe: Context.get(rpc.annotations, RpcExplorerObserve) === true ? 'include' : 'exclude',
      channels: {
        requestPayload: payload.descriptor,
        success: success?.descriptor ?? unavailableChannel,
        typedFailure: typedFailure?.descriptor ?? unavailableChannel,
        defect: defect.descriptor,
        streamElement: streamElement?.descriptor ?? unavailableChannel,
        streamError: streamError?.descriptor ?? unavailableChannel,
        headers: schemaFreeChannel,
      },
      terminal: terminal.descriptor,
      live: {
        payloadSchema: rpc.payloadSchema,
        successSchema: rpc.successSchema,
        errorSchema: rpc.errorSchema,
        defectSchema: rpc.defectSchema,
        terminalSchema,
        annotations: rpc.annotations,
        channels: {
          requestPayload: payload.live,
          ...(success === undefined ? {} : { success: success.live }),
          ...(typedFailure === undefined ? {} : { typedFailure: typedFailure.live }),
          defect: defect.live,
          ...(streamElement === undefined ? {} : { streamElement: streamElement.live }),
          ...(streamError === undefined ? {} : { streamError: streamError.live }),
        },
      },
    })
  }

  return descriptors
}
