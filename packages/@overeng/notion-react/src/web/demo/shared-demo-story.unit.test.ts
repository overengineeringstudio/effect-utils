import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const demoStoriesDir = path.dirname(fileURLToPath(import.meta.url))

describe('shared demo stories', () => {
  const storyFiles = readdirSync(demoStoriesDir)
    .filter((name) => name.endsWith('.stories.tsx'))
    .sort()

  for (const fileName of storyFiles) {
    it(`${fileName} delegates to the shared demo catalog`, () => {
      const source = readFileSync(path.join(demoStoriesDir, fileName), 'utf8')

      expect(source).toContain("from './shared-demo-story.tsx'")
      expect(source).toContain('sharedDemoStory(')
      expect(source).toContain('satisfies Meta')
      expect(source).not.toContain('render: () => (')
    })
  }
})
