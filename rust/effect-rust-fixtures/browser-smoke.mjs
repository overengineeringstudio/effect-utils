// Serve this module and the generated wasm package with application/wasm MIME.
// In a real browser: await runBrowserSmoke(new URL('/product/', location.href)).
import { runWasmSchedulerSmoke } from './wasm-scheduler-smoke.js'

const equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}: ${actual} !== ${expected}`)
}

const checkDelivery = async (packageUrl, worker) => {
  const manifest = await fetch(new URL('package.json', packageUrl)).then((response) => response.json())
  const entry = (path) => new URL(path, packageUrl).href
  const nativeFetch = globalThis.fetch
  const nativeStreaming = WebAssembly.instantiateStreaming
  const nativeInstantiate = WebAssembly.instantiate
  const requests = []
  const streamed = []
  let buffered = 0
  globalThis.fetch = (input, ...args) => {
    const url = new URL(input instanceof Request ? input.url : input, packageUrl)
    if (url.pathname.endsWith('.wasm')) requests.push(url.href)
    return nativeFetch(input, ...args)
  }
  WebAssembly.instantiateStreaming = async (source, ...args) => {
    const response = await source
    equal(response.headers.get('content-type'), 'application/wasm', 'wasm MIME enables streaming')
    streamed.push(response.url)
    return nativeStreaming(response, ...args)
  }
  WebAssembly.instantiate = (...args) => {
    buffered++
    return nativeInstantiate(...args)
  }
  try {
    const inline = await import(entry(manifest.exports['./inline']))
    await inline.default()
    equal(inline.add(20, 22), 42, 'explicit inline API')
    const inlineLoader = await import(entry(manifest.exports['./inline/load']))
    const inlineInstance = await inlineLoader.load()
    equal(inlineInstance.api.add(20, 22), 42, 'explicit inline fresh API')
    inlineInstance.release()
    equal(requests.length, 0, 'inline does not fetch wasm')
    equal(streamed.length, 0, 'inline does not instantiate via streaming')
    buffered = 0

    const root = worker ? manifest.exports['./browser-worker'] : manifest.exports['.'].browser
    const api = await import(entry(root))
    await api.default()
    equal(api.add(20, 22), 42, 'external browser API')
    equal(requests.length, 1, 'default entry requests the external asset once')
    equal(streamed.length, 1, 'default entry instantiates via streaming')
    if (worker === false) {
      const fallback = await import(entry(manifest.exports['.'].default))
      await fallback.default()
      equal(fallback.add(21, 21), 42, 'default condition API')
    }
    const loaderEntry = worker
      ? manifest.exports['./browser-worker/load']
      : manifest.exports['./load'].browser
    const loader = await import(entry(loaderEntry))
    const first = await loader.load()
    const second = await loader.load()
    equal(first.api.add(20, 22), 42, 'first fresh external API')
    equal(second.api.add(21, 21), 42, 'second fresh external API')
    let trapped = false
    try { first.api.panicTest() } catch (cause) { trapped = cause instanceof WebAssembly.RuntimeError }
    equal(trapped, true, 'first lexical instance traps')
    equal(second.api.add(20, 22), 42, 'trap does not poison another lexical instance')
    first.release()
    second.release()
    equal(requests.length, 3, 'root and two fresh loaders each fetch the emitted asset')
    equal(streamed.length, 3, 'every external instance streams')
    equal(buffered, 0, 'external delivery never falls back to buffered instantiation')
    await runWasmSchedulerSmoke({ runtime: worker ? 'browserWorker' : 'browser', load: loader.load })
    equal(new Set(requests).size, 1, 'all entries resolve one emitted wasm asset')
    return { inlineFetches: 0, requests, streamed, buffered, sum: 42, isolatedTrap: true, schedulerScenarios: 5 }
  } finally {
    globalThis.fetch = nativeFetch
    WebAssembly.instantiateStreaming = nativeStreaming
    WebAssembly.instantiate = nativeInstantiate
  }
}

export const runBrowserSmoke = async (packageUrl) => {
  const browser = await checkDelivery(packageUrl, false)
  const worker = new Worker(import.meta.url, { type: 'module' })
  try {
    const browserWorker = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error === undefined ? resolve(data.result) : reject(new Error(data.error))
      worker.onerror = (event) => reject(new Error(event.message))
      worker.postMessage(new URL(packageUrl).href)
    })
    return { passed: true, browser, browserWorker }
  } finally {
    worker.terminate()
  }
}

if (typeof document === 'undefined') {
  self.onmessage = async ({ data }) => {
    try { self.postMessage({ result: await checkDelivery(new URL(data), true) }) }
    catch (cause) { self.postMessage({ error: String(cause?.stack ?? cause) }) }
  }
}
