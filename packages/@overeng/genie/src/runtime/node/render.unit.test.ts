import { describe, expect, it } from 'bun:test'

import { getHeaderComment, renderGeneratedContent } from './render.ts'

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
