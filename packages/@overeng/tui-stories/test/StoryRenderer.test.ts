import { resolve } from 'node:path'

import { describe, it, expect } from '@effect/vitest'
import { Effect } from 'effect'

import { captureStoryProps } from '../src/StoryCapture.ts'
import { discoverStories } from '../src/StoryDiscovery.ts'
import { findStory } from '../src/StoryModule.ts'
import { renderStory } from '../src/StoryRenderer.ts'

const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../../..')
const MEGAREPO_DIR = resolve(WORKSPACE_ROOT, 'packages/@overeng/megarepo')

/* Eagerly kick off discovery once at module load and share the promise across all tests.
   Without this, each test calls discoverStories() independently — the first call per file
   pays the full glob + sequential-import cost (sequential due to the Bun TDZ workaround),
   which on CI exceeds the default 5s vitest timeout. */
const discoveryResult = Effect.runPromise(discoverStories({ packageDirs: [MEGAREPO_DIR] }))

/** Helper to discover + find + capture a story */
const captureOrSkip = (query: string, overrides?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const { modules } = yield* Effect.promise(() => discoveryResult)
    const story = findStory({ modules, query })
    if (story === undefined) {
      console.warn(`Skipping: story "${query}" not found`)
      return undefined
    }
    return yield* Effect.promise(() => captureStoryProps({ story, argOverrides: overrides }))
  })

describe('StoryRenderer', () => {
  it.effect('renders log mode (no colors, no ANSI)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'log',
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output).not.toContain('\x1b[')
    }),
  )

  it.effect('renders ci mode (with ANSI colors)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'ci',
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output).toContain('\x1b[')
    }),
  )

  it.effect('renders ci-plain mode (no colors)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'ci-plain',
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output).not.toContain('\x1b[')
    }),
  )

  it.effect('renders pipe mode (colors, like ci)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'pipe',
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output).toContain('\x1b[')
    }),
  )

  it.effect('renders json mode (state as JSON)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'json',
      })

      const parsed = JSON.parse(output)
      expect(parsed).toBeDefined()
      expect(typeof parsed).toBe('object')
    }),
  )

  it.effect('renders ndjson mode (timeline as JSON lines)', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Add/Results/AddDefault', {
        interactive: true,
      })
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'ndjson',
      })

      const lines = output.split('\n').filter((l) => l.length > 0)
      expect(lines.length).toBeGreaterThan(1)

      for (const line of lines) {
        const parsed = JSON.parse(line)
        expect(parsed).toHaveProperty('at')
        expect(parsed).toHaveProperty('state')
      }
    }),
  )

  it.effect('applies timeline to final state', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Add/Results/AddDefault', {
        interactive: true,
      })
      if (captured === undefined) return

      const initial = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        output: 'log',
      })

      const final = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'final',
        output: 'log',
      })

      expect(final).not.toBe(initial)
    }),
  )

  it.effect('respects width option', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const narrow = yield* renderStory({
        captured,
        width: 40,
        timelineMode: 'initial',
        output: 'log',
      })

      const wide = yield* renderStory({
        captured,
        width: 120,
        timelineMode: 'initial',
        output: 'log',
      })

      expect(narrow.length).toBeGreaterThan(0)
      expect(wide.length).toBeGreaterThan(0)
    }),
  )
})
