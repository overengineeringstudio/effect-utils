import { describe, it, expect } from '@effect/vitest'
import React from 'react'

import {
  parseStoryModule,
  findStory,
  parseArgOverrides,
  type ParsedStoryModule,
} from '../src/StoryModule.ts'

describe('StoryModule', () => {
  describe('parseStoryModule', () => {
    it('parses a minimal CSF module', () => {
      const mod = parseStoryModule({
        exports: {
          default: { title: 'Test/Component' },
          Basic: {
            render: () => React.createElement('div'),
          },
        },
        filePath: '/test/file.stories.tsx',
      })

      expect(mod).toBeDefined()
      expect(mod!.meta.title).toBe('Test/Component')
      expect(mod!.stories).toHaveLength(1)
      expect(mod!.stories[0]!.name).toBe('Basic')
      expect(mod!.stories[0]!.id).toBe('Test/Component/Basic')
    })

    it('merges meta args with story args', () => {
      const mod = parseStoryModule({
        exports: {
          default: {
            title: 'Test/Merged',
            args: { height: 400, verbose: false },
          },
          WithVerbose: {
            args: { verbose: true },
            render: () => React.createElement('div'),
          },
        },
        filePath: '/test/file.stories.tsx',
      })

      expect(mod!.stories[0]!.args).toEqual({ height: 400, verbose: true })
    })

    it('parses argTypes with various control types', () => {
      const mod = parseStoryModule({
        exports: {
          default: {
            title: 'Test/ArgTypes',
            argTypes: {
              flag: { control: { type: 'boolean' }, description: 'A flag' },
              mode: { control: { type: 'select' }, options: ['a', 'b'] },
              name: { control: { type: 'text' } },
              count: { control: { type: 'number' } },
              speed: { control: { type: 'range', min: 0, max: 10, step: 1 } },
            },
          },
          Demo: { render: () => React.createElement('div') },
        },
        filePath: '/test/file.stories.tsx',
      })

      const argTypes = mod!.stories[0]!.argTypes
      expect(argTypes.flag!.control.type).toBe('boolean')
      expect(argTypes.mode!.control.type).toBe('select')
      expect((argTypes.mode!.control as unknown as { options: string[] }).options).toEqual([
        'a',
        'b',
      ])
      expect(argTypes.name!.control.type).toBe('text')
      expect(argTypes.count!.control.type).toBe('number')
      expect(argTypes.speed!.control.type).toBe('range')
    })

    it('handles shorthand control syntax', () => {
      const mod = parseStoryModule({
        exports: {
          default: {
            title: 'Test/Shorthand',
            argTypes: {
              flag: { control: 'boolean' },
              mode: { control: 'select', options: ['x', 'y'] },
            },
          },
          Demo: { render: () => React.createElement('div') },
        },
        filePath: '/test/file.stories.tsx',
      })

      expect(mod!.stories[0]!.argTypes.flag!.control.type).toBe('boolean')
      expect(mod!.stories[0]!.argTypes.mode!.control.type).toBe('select')
    })

    it('returns undefined for modules without title', () => {
      const mod = parseStoryModule({ exports: { default: {} }, filePath: '/test/file.stories.tsx' })
      expect(mod).toBeUndefined()
    })

    it('skips non-story exports', () => {
      const mod = parseStoryModule({
        exports: {
          default: { title: 'Test/Skip' },
          helperFunction: () => 'not a story',
          CONSTANT: 42,
          Story1: { render: () => React.createElement('div') },
        },
        filePath: '/test/file.stories.tsx',
      })

      expect(mod!.stories).toHaveLength(1)
      expect(mod!.stories[0]!.name).toBe('Story1')
    })
  })

  describe('findStory', () => {
    const modules: ParsedStoryModule[] = [
      {
        meta: { title: 'CLI/Status/Basic', args: {}, argTypes: {} },
        stories: [
          {
            name: 'Default',
            title: 'CLI/Status/Basic',
            id: 'CLI/Status/Basic/Default',
            render: () => React.createElement('div'),
            args: {},
            argTypes: {},
            filePath: '/test.tsx',
          },
          {
            name: 'WithErrors',
            title: 'CLI/Status/Basic',
            id: 'CLI/Status/Basic/WithErrors',
            render: () => React.createElement('div'),
            args: {},
            argTypes: {},
            filePath: '/test.tsx',
          },
        ],
        filePath: '/test.tsx',
      },
    ]

    it('finds by exact ID', () => {
      expect(findStory({ modules, query: 'CLI/Status/Basic/Default' })?.name).toBe('Default')
    })

    it('finds by exact ID (case insensitive)', () => {
      expect(findStory({ modules, query: 'cli/status/basic/default' })?.name).toBe('Default')
    })

    it('finds first story by title prefix', () => {
      expect(findStory({ modules, query: 'CLI/Status/Basic' })?.name).toBe('Default')
    })

    it('finds by substring', () => {
      expect(findStory({ modules, query: 'WithErrors' })?.name).toBe('WithErrors')
    })

    it('returns undefined for no match', () => {
      expect(findStory({ modules, query: 'NonExistent' })).toBeUndefined()
    })
  })

  describe('parseArgOverrides', () => {
    it('parses key=value pairs', () => {
      expect(parseArgOverrides(['verbose=true', 'mode=parallel', 'count=5'])).toEqual({
        verbose: true,
        mode: 'parallel',
        count: 5,
      })
    })

    it('handles boolean values', () => {
      expect(parseArgOverrides(['flag=true', 'other=false'])).toEqual({
        flag: true,
        other: false,
      })
    })

    it('handles bare keys as true', () => {
      expect(parseArgOverrides(['verbose'])).toEqual({ verbose: true })
    })

    it('handles string values', () => {
      expect(parseArgOverrides(['name=hello world'])).toEqual({ name: 'hello world' })
    })
  })
})
