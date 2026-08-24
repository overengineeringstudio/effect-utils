import { Command } from 'effect/unstable/cli'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeNotionRootCommand } from './cli.ts'
import { dbCommand } from './commands/db/mod.ts'

const placeholderCommand = (name: string) =>
  Command.make(name, {}, () => Effect.void).pipe(Command.withDescription(`${name} command`))

const subcommandNames = (command: Command.Command.Any): readonly string[] =>
  command.subcommands.flatMap((group) => group.commands.map((sub) => sub.name))

describe('notion root command composition', () => {
  it('exposes md/schema/db plus the top-level edit alias, not the removed sqlite command', () => {
    const command = makeNotionRootCommand({
      schemaCommand: placeholderCommand('schema'),
      dbCommand: placeholderCommand('db'),
      notionMdDispatchCommand: placeholderCommand('md'),
      notionEditAliasCommand: placeholderCommand('edit'),
    })

    const names = subcommandNames(command)

    expect(names).toContain('schema')
    expect(names).toContain('db')
    expect(names).toContain('md')
    // R18: the top-level `notion edit` marquee alias is a first-level command.
    expect(names).toContain('edit')
    expect(names).not.toContain('sqlite')
  })
})

describe('notion db command composition', () => {
  it('keeps promoted db commands while excluding retired namespaces', () => {
    const names = subcommandNames(dbCommand)

    expect(names).toContain('info')
    expect(names).toContain('sync')
    expect(names).toContain('export')
    expect(names).toContain('status')
    expect(names).not.toContain('dump')
    expect(names).not.toContain('replica')
    expect(names).not.toContain('migrate')
    expect(names).not.toContain('repair')
  })
})
