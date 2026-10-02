import { writeFileSync } from 'node:fs'

import { Effect } from 'effect'
import type { Interop } from '@overeng/effect-rust'
import { EffectRustFixture } from 'effect-rust-fixture'

const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

/** The service tag and method types come exclusively from the generated package. */
export const digest: Effect.Effect<string, Interop.Input | Interop.Transport, EffectRustFixture> = Effect.gen(function* () {
  const fixture = yield* EffectRustFixture
  return yield* fixture.sha256Hex(new TextEncoder().encode('abc'))
})

export const smoke = async (): Promise<void> => {
  const runtime = process.versions['bun'] === undefined ? 'node' : 'bun'
  for (const layer of [EffectRustFixture.layerWasm[runtime](), EffectRustFixture.layerNative[runtime]()]) {
    const actual = await Effect.runPromise(digest.pipe(Effect.provide(layer), Effect.scoped))
    if (actual !== expected) throw new Error(`Generated package digest mismatch: ${actual}`)
  }
  const result = JSON.stringify({ generatedPackage: 'effect-rust-fixture', wasm: expected, native: expected }) + '\n'
  const output = process.env['RUST_INTEROP_SMOKE_OUTPUT']
  if (output !== undefined) writeFileSync(output, result)
  process.stdout.write(result)
}

await smoke()
