// Bundle with effect_rust_fixture resolving to the generated wasm package and
// .wasm imports emitted as workerd CompiledWasm modules, then call this Worker.
import initialize, { add } from 'effect_rust_fixture/workerd'
import { load } from 'effect_rust_fixture/workerd/load'
import { runWasmSchedulerSmoke } from './wasm-scheduler-smoke.js'

export default {
  async fetch() {
    const nativeFetch = globalThis.fetch
    globalThis.fetch = () => { throw new Error('workerd precompiled initialization must not fetch') }
    try {
      initialize()
      if (add(20, 22) !== 42) throw new Error('workerd root API failed')
      const first = load()
      const second = load()
      if (first.api.add(20, 22) !== 42 || second.api.add(21, 21) !== 42) {
        throw new Error('workerd fresh API failed')
      }
      let trapped = false
      try { first.api.panicTest() } catch (cause) { trapped = cause instanceof WebAssembly.RuntimeError }
      if (trapped === false || second.api.add(20, 22) !== 42) {
        throw new Error('workerd lexical instance isolation failed')
      }
      first.release()
      second.release()
      await runWasmSchedulerSmoke({ runtime: 'workerd', load })
      return Response.json({ passed: true, runtime: 'workerd', precompiled: true, fetches: 0, sum: 42, isolatedTrap: true, schedulerScenarios: 5 })
    } finally {
      globalThis.fetch = nativeFetch
    }
  },
}
