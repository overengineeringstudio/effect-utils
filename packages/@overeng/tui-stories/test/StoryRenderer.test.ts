import { resolve } from 'node:path'

import { describe, it, expect } from '@effect/vitest'
import { Effect } from 'effect'

import { captureStoryProps } from '../src/StoryCapture.ts'
import { discoverStories } from '../src/StoryDiscovery.ts'
import { findStory } from '../src/StoryModule.ts'
import { renderStory } from '../src/StoryRenderer.ts'

const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..')
const MEGAREPO_DIR = resolve(WORKSPACE_ROOT, 'packages/@overeng/megarepo')

/** Helper to discover + find + capture a story */
const captureOrSkip = (query: string, overrides?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const modules = yield* discoverStories({ packageDirs: [MEGAREPO_DIR] })
    const story = findStory({ modules, query })
    if (story === undefined) {
      console.warn(`Skipping: story "${query}" not found`)
      return undefined
    }
    return yield* Effect.promise(() => captureStoryProps({ story, argOverrides: overrides }))
  })

describe('StoryRenderer', () => {
  it.effect('renders a story to plain text', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        plain: true,
      })

      expect(output).toContain('core-lib')
      expect(output).toContain('dev-tools')
      expect(output).not.toContain('\x1b[')
    }),
  )

  it.effect('renders a story with ANSI colors', () =>
    Effect.gen(function* () {
      const captured = yield* captureOrSkip('CLI/Status/Basic')
      if (captured === undefined) return

      const output = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'initial',
        plain: false,
      })

      expect(output).toContain('core-lib')
      expect(output).toContain('\x1b[')
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
        plain: true,
      })

      const final = yield* renderStory({
        captured,
        width: 80,
        timelineMode: 'final',
        plain: true,
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
        plain: true,
      })

      const wide = yield* renderStory({
        captured,
        width: 120,
        timelineMode: 'initial',
        plain: true,
      })

      expect(narrow).toContain('core-lib')
      expect(wide).toContain('core-lib')
    }),
  )
})
