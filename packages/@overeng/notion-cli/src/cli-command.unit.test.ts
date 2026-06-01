import { Command } from '@effect/cli'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeNotionRootCommand } from './cli.ts'

const placeholderCommand = (name: string) =>
  Command.make(name, {}, () => Effect.void).pipe(Command.withDescription(`${name} command`))

describe('notion root command composition', () => {
  it('includes sqlite in the Effect CLI command tree used for completions', async () => {
    const command = makeNotionRootCommand({
      schemaCommand: placeholderCommand('schema'),
      dbCommand: placeholderCommand('db'),
      notionMdDispatchCommand: placeholderCommand('md'),
    })

    const completions = await Effect.runPromise(Command.getBashCompletions(command, 'notion'))
    const completionText = completions.join('\n')

    expect(completionText).toContain('schema')
    expect(completionText).toContain('db')
    expect(completionText).toContain('md')
    expect(completionText).toContain('sqlite')
  })
})
