import { Context, Effect, Layer, ManagedRuntime } from 'effect'

import { Init } from './errors.ts'
import { makeRuntime, type InstanceFactory, type Runtime, type RuntimeOptions } from './instance.ts'

export { Init, Input, Transport, Unsupported } from './errors.ts'
export { hostCapability, type CancellationMode, type HostCapability } from './host.ts'
export { chunkProfiles, type CallOptions, type ChunkProfile, type InputHandle, type Instance, type InstanceFactory, type Invocation, type OutputHandle, type PanicPolicy, type Runtime, type RustJob, type Start } from './instance.ts'
export { processLayer, type ProcessClient, type ProcessLayerOptions } from './process.ts'
export { workerLayer, serveWorker, browserWorkerEndpoint, nodeWorkerEndpoint, type MessageEndpoint, type NodeWorker, type WorkerLayerOptions } from './worker.ts'

export interface LayerOptions<TApi, TService> extends RuntimeOptions<TApi> {
  readonly make: (runtime: Runtime<TApi>) => TService
}

const instanceLayer = <TId, TService, TApi>(runtimeName: string, Service: Context.Key<TId, TService>, options: LayerOptions<TApi, TService>): Layer.Layer<TId, Init> =>
  Layer.effect(Service, Effect.gen(function* () {
    const runtime = yield* makeRuntime(runtimeName, options)
    return yield* Effect.try({ try: () => options.make(runtime), catch: (cause) => new Init({ runtime: runtimeName, message: 'Unable to construct generated service', cause }) })
  }))

/** Each constructor is explicit. No environment detection and no transport fallback. */
export const wasmLayer = {
  node: <TId, TService, TApi>(Service: Context.Key<TId, TService>, options: LayerOptions<TApi, TService>): Layer.Layer<TId, Init> => instanceLayer('wasm.node', Service, options),
  bun: <TId, TService, TApi>(Service: Context.Key<TId, TService>, options: LayerOptions<TApi, TService>): Layer.Layer<TId, Init> => instanceLayer('wasm.bun', Service, options),
  browser: <TId, TService, TApi>(Service: Context.Key<TId, TService>, options: LayerOptions<TApi, TService>): Layer.Layer<TId, Init> => instanceLayer('wasm.browser', Service, options),
  worker: <TId, TService, TApi>(Service: Context.Key<TId, TService>, options: LayerOptions<TApi, TService>): Layer.Layer<TId, Init> => instanceLayer('wasm.worker', Service, options),
} as const

const nativePanic = (cause: unknown): boolean => cause instanceof Error && cause.message.startsWith('RUST_PANIC:')
export const nativeLayer = {
  node: <TId, TService, TApi>(Service: Context.Key<TId, TService>, options: LayerOptions<TApi, TService>): Layer.Layer<TId, Init> => instanceLayer('native.node', Service, { ...options, isPanic: options.isPanic ?? nativePanic }),
  bun: <TId, TService, TApi>(Service: Context.Key<TId, TService>, options: LayerOptions<TApi, TService>): Layer.Layer<TId, Init> => instanceLayer('native.bun', Service, { ...options, isPanic: options.isPanic ?? nativePanic }),
} as const

export interface WasmLoaders<TApi> { readonly node: InstanceFactory<TApi>; readonly bun: InstanceFactory<TApi>; readonly browser: InstanceFactory<TApi>; readonly worker: InstanceFactory<TApi> }
export interface NativeLoaders<TApi> { readonly node: InstanceFactory<TApi>; readonly bun: InstanceFactory<TApi> }
/** Each record is present only when the corresponding product was built. */
export interface GeneratedStatics<TApi, TService> {
  readonly make: (runtime: Runtime<TApi>) => TService
  readonly wasm?: WasmLoaders<TApi>
  readonly native?: NativeLoaders<TApi>
}
export type StaticOptions = Omit<RuntimeOptions<never>, 'load' | 'isPanic'>
export interface WasmLayers<TId> {
  readonly node: (options?: StaticOptions) => Layer.Layer<TId, Init>
  readonly bun: (options?: StaticOptions) => Layer.Layer<TId, Init>
  readonly browser: (options?: StaticOptions) => Layer.Layer<TId, Init>
  readonly worker: (options?: StaticOptions) => Layer.Layer<TId, Init>
}
export interface NativeLayers<TId> {
  readonly node: (options?: StaticOptions) => Layer.Layer<TId, Init>
  readonly bun: (options?: StaticOptions) => Layer.Layer<TId, Init>
}
/** Statics for exactly the products supplied: `layerWasm` with wasm loaders, `layerNative` with native loaders. */
export type Statics<TId, TGenerated> =
  & (TGenerated extends { readonly wasm: object } ? { readonly layerWasm: WasmLayers<TId> } : {})
  & (TGenerated extends { readonly native: object } ? { readonly layerNative: NativeLayers<TId> } : {})

/** Generated Service classes spread these statics without exporting a global instance. */
export const defineStatics = <TId, TApi, TService, const TGenerated extends GeneratedStatics<TApi, TService>>(
  Service: Context.Key<TId, TService>,
  generated: TGenerated & GeneratedStatics<TApi, TService>,
): Statics<TId, TGenerated> => {
  const { make, wasm, native } = generated
  const layerWasm: WasmLayers<TId> | undefined = wasm && {
    node: (options = {}) => wasmLayer.node(Service, { ...options, load: wasm.node, make }),
    bun: (options = {}) => wasmLayer.bun(Service, { ...options, load: wasm.bun, make }),
    browser: (options = {}) => wasmLayer.browser(Service, { ...options, load: wasm.browser, make }),
    worker: (options = {}) => wasmLayer.worker(Service, { ...options, load: wasm.worker, make }),
  }
  const layerNative: NativeLayers<TId> | undefined = native && {
    node: (options = {}) => nativeLayer.node(Service, { ...options, load: native.node, make }),
    bun: (options = {}) => nativeLayer.bun(Service, { ...options, load: native.bun, make }),
  }
  // The conditional result type mirrors exactly which records were supplied.
  return { ...(layerWasm && { layerWasm }), ...(layerNative && { layerNative }) } as Statics<TId, TGenerated>
}

/** Create once at the isolate entrypoint; dispose on isolate shutdown, not per request. */
export const isolateRuntime = <TServices, TError>(layer: Layer.Layer<TServices, TError>): ManagedRuntime.ManagedRuntime<TServices, TError> => ManagedRuntime.make(layer)
