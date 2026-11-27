import { describe, expect, it } from 'vitest'

import { renderGenieOutput } from '@overeng/genie/render'

import { getHeaderComment, renderGeneratedContent } from './render.ts'

const context = { cwd: '/workspace', location: 'buck2/dependencies', mode: 'check' as const }

describe('renderGenieOutput', () => {
  it.each([
    ['BUCK', '# Generated file - DO NOT EDIT\n# Source: BUCK.genie.ts\n\nbody\n'],
    ['package.json', 'body\n'],
    ['.watchmanconfig', 'body\n'],
    ['tsconfig.json', '// Generated file - DO NOT EDIT\n// Source: tsconfig.json.genie.ts\nbody\n'],
    ['config.yaml', '# Generated file - DO NOT EDIT\n# Source: config.yaml.genie.ts\n\nbody\n'],
    ['file.ts', '// Generated file - DO NOT EDIT\n// Source: file.ts.genie.ts\nbody\n'],
  ])('renders %s', (target, expected) => {
    expect(
      renderGenieOutput({
        output: { stringify: () => 'body\n' },
        context,
        genieFilePath: `/workspace/${target}.genie.ts`,
      }),
    ).toBe(expected)
  })

  it('forwards the context and formats before adding the header', () => {
    expect(
      renderGenieOutput({
        output: {
          stringify: (ctx: typeof context) => {
            expect(ctx).toBe(context)
            return 'raw'
          },
        },
        context,
        genieFilePath: 'BUCK.genie.ts',
        format: (content) => `${content.toUpperCase()}\n`,
      }),
    ).toBe('# Generated file - DO NOT EDIT\n# Source: BUCK.genie.ts\n\nRAW\n')
  })

  it.each(['#!/bin/sh', '#!/bin/sh\necho hello\n', '#!/usr/bin/env node\r\nrun()\r\n'])(
    'preserves leading shebang %j',
    (content) => {
      const result = renderGenieOutput({
        output: { stringify: () => content },
        context,
        genieFilePath: 'run.sh.genie.ts',
      })
      expect(result.startsWith(`${content.split('\n')[0]}\n# Generated file`)).toBe(true)
    },
  )
})

const sourceFile = 'SKILL.md.genie.ts'
const header = '<!-- Generated file - DO NOT EDIT\nSource: SKILL.md.genie.ts\n-->\n\n'
const renderMarkdown = (content: string): string =>
  renderGeneratedContent({ content, sourceFile, targetFilePath: 'skills/notion/SKILL.md' })

describe('Markdown generated provenance', () => {
  it('uses an HTML comment instead of JavaScript comments', () => {
    expect(getHeaderComment({ targetFilePath: 'SKILL.md', sourceFile })).toBe(header)
  })

  it.each(['\n', '\r\n'])('keeps leading YAML frontmatter intact with %j line endings', (eol) => {
    const frontmatter = ['---', 'name: notion', 'description: Any Notion work', '---', ''].join(eol)
    const body = `${eol}# Notion${eol}`
    expect(renderMarkdown(frontmatter + body)).toBe(frontmatter + header + body)
  })

  it('separates provenance from frontmatter ending at EOF', () => {
    const frontmatter = '---\nname: notion\n---'
    expect(renderMarkdown(frontmatter)).toBe(`${frontmatter}\n${header}`)
  })

  it('keeps an empty leading YAML block first', () => {
    expect(renderMarkdown('---\n---\n# Body\n')).toBe(`---\n---\n${header}# Body\n`)
  })

  it('prepends provenance when there is no leading YAML block', () => {
    const body = '# Notion\n\n---\nnot frontmatter\n---\n'
    expect(renderMarkdown(body)).toBe(header + body)
  })

  it('does not consume an unterminated YAML block', () => {
    const body = '---\nname: notion\n'
    expect(renderMarkdown(body)).toBe(header + body)
  })

  it('preserves existing non-Markdown shebang handling', () => {
    expect(
      renderGeneratedContent({
        content: '#!/usr/bin/env node\nconsole.log(1)\n',
        sourceFile: 'tool.mjs.genie.ts',
        targetFilePath: 'tool.mjs',
      }),
    ).toBe('#!/usr/bin/env node\n// Generated file - DO NOT EDIT\n// Source: tool.mjs.genie.ts\nconsole.log(1)\n')
  })
})
