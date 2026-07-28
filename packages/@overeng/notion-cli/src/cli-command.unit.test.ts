import { Command } from 'effect/unstable/cli'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeNotionRootCommand } from './cli.ts'
import { dbCommand } from './commands/db/mod.ts'

const placeholderCommand = (name: string) =>
  Command.make(name, {}, () => Effect.void).pipe(Command.withDescription(`${name} command`))

describe('notion root command composition', () => {
  it('exposes md/schema/db plus the top-level edit alias, not the removed sqlite command', async () => {
    const command = makeNotionRootCommand({
      schemaCommand: placeholderCommand('schema'),
      dbCommand: placeholderCommand('db'),
      notionMdDispatchCommand: placeholderCommand('md'),
      notionEditAliasCommand: placeholderCommand('edit'),
    })

    const completions = await Effect.runPromise(Command.getBashCompletions(command, 'notion'))
    const completionText = completions.join('\n')

    expect(completionText).toContain('schema')
    expect(completionText).toContain('db')
    expect(completionText).toContain('md')
    // R18: the top-level `notion edit` marquee alias is a first-level command.
    expect(completionText).toContain('edit')
    expect(completionText).not.toContain('sqlite')
  })
})

describe('notion db command composition', () => {
  it('keeps promoted db commands while excluding retired namespaces', async () => {
    const completions = await Effect.runPromise(Command.getBashCompletions(dbCommand, 'notion db'))
    const completionText = completions.join('\n')

    expect(completionText).toContain('info')
    expect(completionText).toContain('sync')
    expect(completionText).toContain('export')
    expect(completionText).toContain('status')
    expect(completionText).not.toContain('dump')
    expect(completionText).not.toContain('replica')
    expect(completionText).not.toContain('migrate')
    expect(completionText).not.toContain('repair')
  })
})
