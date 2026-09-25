import { Schema } from 'effect'
import * as OpenApi from 'effect/unstable/httpapi/OpenApi'
import { Rpc, RpcGroup, RpcMiddleware } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import { makeRpcDescriptors, RpcExplorerObserve } from './descriptor.ts'
import { RpcDescriptorWire } from './inspector.ts'

const unaryPayload = Schema.Struct({ id: Schema.String })
const unarySuccess = Schema.String.annotate({ title: 'Unary success' })
const unaryFailure = Schema.Struct({ reason: Schema.String })
const streamElement = Schema.Struct({ value: Schema.Finite })
const streamFailure = Schema.String.annotate({ title: 'Stream failure' })

const unary = Rpc.make('GetValue', {
  payload: unaryPayload,
  success: unarySuccess,
  error: unaryFailure,
})
const stream = Rpc.make('WatchValues', {
  payload: Schema.Void,
  success: streamElement,
  error: streamFailure,
  stream: true,
})

describe('RPC descriptors', () => {
  it('projects unary and stream channels in RpcGroup request order', () => {
    const descriptors = makeRpcDescriptors(RpcGroup.make(stream, unary))

    expect(descriptors.map(({ descriptorId, kind, tag }) => ({ descriptorId, kind, tag }))).toEqual(
      [
        {
          descriptorId: 'rpc:effect/rpc/Rpc/WatchValues',
          kind: 'stream',
          tag: 'WatchValues',
        },
        {
          descriptorId: 'rpc:effect/rpc/Rpc/GetValue',
          kind: 'unary',
          tag: 'GetValue',
        },
      ],
    )

    const streamDescriptor = descriptors[0]!
    expect(streamDescriptor.channels.streamElement.projection).toBe('bestEffort')
    expect(streamDescriptor.channels.streamError.schema?.schema.title).toBe('Stream failure')
    expect(streamDescriptor.channels.success).toEqual({ projection: 'unavailable' })
    expect(streamDescriptor.channels.typedFailure).toEqual({ projection: 'unavailable' })
    expect(streamDescriptor.channels.headers).toEqual({ projection: 'available' })
    expect(streamDescriptor.live?.channels.streamElement?.schema).toBe(streamElement)
    expect(streamDescriptor.live?.channels.streamError?.schema).toBe(streamFailure)

    const unaryDescriptor = descriptors[1]!
    expect(unaryDescriptor.channels.success.schema?.schema.title).toBe('Unary success')
    expect(unaryDescriptor.channels.typedFailure.projection).toBe('bestEffort')
    expect(unaryDescriptor.channels.streamElement).toEqual({ projection: 'unavailable' })
    expect(unaryDescriptor.channels.streamError).toEqual({ projection: 'unavailable' })
    expect(unaryDescriptor.terminal.projection).toBe('bestEffort')
    expect(unaryDescriptor.live?.payloadSchema).toBe(unaryPayload)
    expect(unaryDescriptor.live?.successSchema).toBe(unarySuccess)
    expect(unaryDescriptor.live?.errorSchema).toBe(unaryFailure)
  })

  it('rejects empty or control-character RPC keys', () => {
    const emptyKeyRpc = Rpc.make('EmptyKey')
    Object.defineProperty(emptyKeyRpc, 'key', { value: '' })

    expect(() => makeRpcDescriptors(RpcGroup.make(emptyKeyRpc))).toThrow(
      'RPC descriptor keys must be non-empty and contain no control characters',
    )
    expect(() => makeRpcDescriptors(RpcGroup.make(Rpc.make('bad\nkey')))).toThrow(
      'RPC descriptor keys must be non-empty and contain no control characters',
    )
  })

  it('keeps descriptors usable when JSON Schema projection fails', () => {
    const projectionFailure = new Proxy(Schema.String, {
      get: (target, property, receiver) => {
        if (property === 'ast') throw new Error('projection sentinel')
        return Reflect.get(target, property, receiver)
      },
    })
    const [descriptor] = makeRpcDescriptors(
      RpcGroup.make(Rpc.make('ProjectionFailure', { payload: projectionFailure })),
    )

    expect(descriptor).toBeDefined()
    expect(descriptor!.channels.requestPayload).toEqual({
      projection: 'unavailable',
      warning: 'JSON Schema projection unavailable',
    })
    expect(descriptor!.channels.requestPayload.warning!.length).toBeLessThan(128)
    expect(descriptor!.channels.success.projection).toBe('bestEffort')
    expect(descriptor!.live?.payloadSchema).toBe(projectionFailure)
  })

  it('excludes annotated self-inspection RPCs while including application RPCs by default', () => {
    const inspector = Rpc.make('ExplorerWatch').annotate(RpcExplorerObserve, false)
    const [applicationDescriptor, inspectorDescriptor] = makeRpcDescriptors(
      RpcGroup.make(Rpc.make('ApplicationRpc'), inspector),
    )

    expect(applicationDescriptor!.observe).toBe('include')
    expect(inspectorDescriptor!.observe).toBe('exclude')
  })

  it('projects only explicitly set RPC documentation, including false deprecation', () => {
    const annotated = Rpc.make('Documented')
      .annotate(OpenApi.Title, 'Read project')
      .annotate(OpenApi.Summary, 'Returns a project by ID.')
      .annotate(OpenApi.Description, 'Reads the public project record.')
      .annotate(OpenApi.Deprecated, true)
    const partial = Rpc.make('Current').annotate(OpenApi.Deprecated, false)
    const [fullDescriptor, partialDescriptor, bareDescriptor] = makeRpcDescriptors(
      RpcGroup.make(annotated, partial, Rpc.make('Bare')),
    )

    const docs = ({
      title,
      summary,
      description,
      deprecated,
    }: {
      readonly title?: string | undefined
      readonly summary?: string | undefined
      readonly description?: string | undefined
      readonly deprecated?: boolean | undefined
    }) => ({ title, summary, description, deprecated })
    expect(docs(fullDescriptor!)).toEqual({
      title: 'Read project',
      summary: 'Returns a project by ID.',
      description: 'Reads the public project record.',
      deprecated: true,
    })
    expect(docs(partialDescriptor!)).toEqual({
      title: undefined,
      summary: undefined,
      description: undefined,
      deprecated: false,
    })
    expect(docs(bareDescriptor!)).toEqual({
      title: undefined,
      summary: undefined,
      description: undefined,
      deprecated: undefined,
    })
    expect(Schema.decodeUnknownSync(RpcDescriptorWire)(fullDescriptor!)).toHaveProperty(
      'title',
      'Read project',
    )
    expect(Schema.decodeUnknownSync(RpcDescriptorWire)(partialDescriptor!)).toHaveProperty(
      'deprecated',
      false,
    )
    const bareWire = Schema.decodeUnknownSync(RpcDescriptorWire)(bareDescriptor!)
    expect(Object.keys(bareWire)).not.toContain('title')
    expect(Object.keys(bareWire)).not.toContain('summary')
    expect(Object.keys(bareWire)).not.toContain('description')
    expect(Object.keys(bareWire)).not.toContain('deprecated')
  })

  it('accepts middleware-carrying groups that AnyWithProps variance rejects', () => {
    const ObservingMiddleware =
      RpcMiddleware.Service<'ObservingMiddleware'>()('ObservingMiddleware')
    const observed = Rpc.make('ObservedRpc', { success: Schema.String }).middleware(
      ObservingMiddleware,
    )

    const [descriptor] = makeRpcDescriptors(RpcGroup.make(observed))

    expect(descriptor?.tag).toBe('ObservedRpc')
    expect(descriptor?.observe).toBe('include')
  })
})
