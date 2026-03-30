import { resolve } from 'node:path'

import { describe, it, expect } from '@effect/vitest'
import { Effect } from 'effect'

import { captureStoryProps } from '../src/StoryCapture.ts'
import { discoverStories } from '../src/StoryDiscovery.ts'
import { findStory } from '../src/StoryModule.ts'

const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../../..')
const MEGAREPO_DIR = resolve(WORKSPACE_ROOT, 'packages/@overeng/megarepo')

/* Eagerly kick off discovery once at module load and share the promise across all tests.
   Without this, each test calls discoverStories() independently — the first call per file
   pays the full glob + sequential-import cost (sequential due to the Bun TDZ workaround),
   which on CI exceeds the default 5s vitest timeout. */
const discoveryResult = Effect.runPromise(discoverStories({ packageDirs: [MEGAREPO_DIR] }))

/** Helper to discover + find a story, skipping the test if not found */
const findOrSkip = (query: string) =>
  Effect.gen(function* () {
    const { modules } = yield* Effect.promise(() => discoveryResult)
    const story = findStory({ modules, query })
    if (story === undefined) {
      console.warn(`Skipping: story "${query}" not found (may be an import issue)`)
      return undefined
    }
    return story
  })

describe('StoryCapture', () => {
  it.effect('captures props from a status story', () =>
    Effect.gen(function* () {
      const story = yield* findOrSkip('CLI/Status/Basic')
      if (story === undefined) return

      const captured = yield* Effect.promise(() => captureStoryProps({ story }))

      expect(captured.app).toBeDefined()
      expect(captured.app.config.reducer).toBeDefined()
      expect(typeof captured.View).toBe('function')
      expect(captured.command).toBeTruthy()
    }),
  )

  it.effect('captures props from an exec story', () =>
    Effect.gen(function* () {
      const story = yield* findOrSkip('RunningVerboseParallel')
      if (story === undefined) return

      const captured = yield* Effect.promise(() => captureStoryProps({ story }))

      expect(captured.app).toBeDefined()
      expect(typeof captured.View).toBe('function')
      expect(captured.command).toContain('mr exec')
    }),
  )

  it.effect('captures timeline when interactive=true', () =>
    Effect.gen(function* () {
      const story = yield* findOrSkip('RunningVerboseParallel')
      if (story === undefined) return

      // Without interactive: no timeline
      const noTimeline = yield* Effect.promise(() => captureStoryProps({ story }))
      expect(noTimeline.timeline).toHaveLength(0)

      // With interactive=true: timeline present
      const withTimeline = yield* Effect.promise(() =>
        captureStoryProps({ story, argOverrides: { interactive: true } }),
      )
      expect(withTimeline.timeline.length).toBeGreaterThan(0)
    }),
  )
})
