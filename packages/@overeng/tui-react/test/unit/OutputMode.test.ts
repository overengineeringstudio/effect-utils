/**
 * Tests for OutputMode service
 */

import { Effect, Layer } from 'effect'
import { describe, test, expect } from 'vitest'

import {
  OutputModeTag,
  progressiveVisual,
  finalVisual,
  finalJson,
  progressiveJson,
  fromFlags,
  fromFlagsWithTTY,
  isVisual,
  isJson,
  isProgressive,
  isFinal,
  layer,
  progressiveVisualLayer,
  finalJsonLayer,
} from '../../src/effect/OutputMode.ts'

describe('OutputMode constructors', () => {
  test('progressiveVisual has correct tag', () => {
    expect(progressiveVisual._tag).toBe('progressive-visual')
  })

  test('finalVisual has correct tag', () => {
    expect(finalVisual._tag).toBe('final-visual')
  })

  test('finalJson has correct tag', () => {
    expect(finalJson._tag).toBe('final-json')
  })

  test('progressiveJson has correct tag', () => {
    expect(progressiveJson._tag).toBe('progressive-json')
  })
})

describe('fromFlags', () => {
  test('json=false, stream=false returns progressive-visual', () => {
    const mode = fromFlags({ json: false, stream: false })
    expect(mode._tag).toBe('progressive-visual')
  })

  test('json=true, stream=false returns final-json', () => {
    const mode = fromFlags({ json: true, stream: false })
    expect(mode._tag).toBe('final-json')
  })

  test('json=true, stream=true returns progressive-json', () => {
    const mode = fromFlags({ json: true, stream: true })
    expect(mode._tag).toBe('progressive-json')
  })

  test('json=false, stream=true returns progressive-visual (stream ignored without json)', () => {
    const mode = fromFlags({ json: false, stream: true })
    expect(mode._tag).toBe('progressive-visual')
  })
})

describe('fromFlagsWithTTY', () => {
  test('json=true overrides TTY detection', () => {
    const mode = fromFlagsWithTTY({ json: true, stream: false })
    expect(mode._tag).toBe('final-json')
  })

  test('json=true, stream=true returns progressive-json', () => {
    const mode = fromFlagsWithTTY({ json: true, stream: true })
    expect(mode._tag).toBe('progressive-json')
  })

  // Note: TTY detection depends on environment, can't easily test both paths
})

describe('guards', () => {
  test('isVisual returns true for visual modes', () => {
    expect(isVisual(progressiveVisual)).toBe(true)
    expect(isVisual(finalVisual)).toBe(true)
    expect(isVisual(finalJson)).toBe(false)
    expect(isVisual(progressiveJson)).toBe(false)
  })

  test('isJson returns true for JSON modes', () => {
    expect(isJson(progressiveVisual)).toBe(false)
    expect(isJson(finalVisual)).toBe(false)
    expect(isJson(finalJson)).toBe(true)
    expect(isJson(progressiveJson)).toBe(true)
  })

  test('isProgressive returns true for progressive modes', () => {
    expect(isProgressive(progressiveVisual)).toBe(true)
    expect(isProgressive(finalVisual)).toBe(false)
    expect(isProgressive(finalJson)).toBe(false)
    expect(isProgressive(progressiveJson)).toBe(true)
  })

  test('isFinal returns true for final modes', () => {
    expect(isFinal(progressiveVisual)).toBe(false)
    expect(isFinal(finalVisual)).toBe(true)
    expect(isFinal(finalJson)).toBe(true)
    expect(isFinal(progressiveJson)).toBe(false)
  })
})

describe('layers', () => {
  test('layer creates a valid layer', async () => {
    const mode = await Effect.gen(function* () {
      return yield* OutputModeTag
    }).pipe(Effect.provide(layer(finalJson)), Effect.runPromise)

    expect(mode._tag).toBe('final-json')
  })

  test('progressiveVisualLayer provides progressive-visual', async () => {
    const mode = await Effect.gen(function* () {
      return yield* OutputModeTag
    }).pipe(Effect.provide(progressiveVisualLayer), Effect.runPromise)

    expect(mode._tag).toBe('progressive-visual')
  })

  test('finalJsonLayer provides final-json', async () => {
    const mode = await Effect.gen(function* () {
      return yield* OutputModeTag
    }).pipe(Effect.provide(finalJsonLayer), Effect.runPromise)

    expect(mode._tag).toBe('final-json')
  })
})

describe('OutputModeTag service', () => {
  test('can be yielded in Effect.gen', async () => {
    const program = Effect.gen(function* () {
      const mode = yield* OutputModeTag
      return mode._tag
    })

    const result = await program.pipe(
      Effect.provide(Layer.succeed(OutputModeTag, progressiveJson)),
      Effect.runPromise,
    )

    expect(result).toBe('progressive-json')
  })
})
